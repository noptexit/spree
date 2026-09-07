module Spree
  module Prices
    # Bulk-writes Spree::Price rows and sweeps stale placeholder rows in
    # one transaction.
    #
    # `spree_prices` is guarded by two partial unique indexes on PG/SQLite
    # (collapsed to one composite index on MySQL):
    #   - base prices (price_list_id IS NULL): unique on (variant_id, currency)
    #   - overrides   (price_list_id IS NOT NULL): unique on
    #     (variant_id, currency, price_list_id, min_quantity)
    # A single `upsert_all` can only target one index, so rows ship in two
    # batches — base vs override — each routed to the correct ON CONFLICT.
    #
    # Both indexes are also partial on `amount IS NOT NULL`, so `upsert_all`
    # can't see placeholder rows (amount IS NULL) as conflict targets —
    # filling in a placeholder via upsert inserts a sibling row instead of
    # updating. The post-write sweep removes those.
    class BulkUpsert
      prepend Spree::ServiceModule::Base

      # Two partial unique indexes guard `spree_prices` on PG/SQLite:
      #   - base prices (price_list_id IS NULL): unique on (variant_id, currency)
      #   - overrides   (price_list_id IS NOT NULL): unique on
      #     (variant_id, currency, price_list_id, min_quantity)
      # A single `upsert_all` can only target one index, so base-price rows
      # and override rows ship in separate batches.
      BASE_UNIQUE_BY = %i[variant_id currency].freeze
      OVERRIDE_UNIQUE_BY = %i[variant_id currency price_list_id min_quantity].freeze

      # @param rows [Array<Hash>] each row must carry
      #   `variant_id`, `currency`, and `amount`; `price_list_id`,
      #   `min_quantity` and `compare_at_amount` are optional. A blank
      #   `amount` is treated as "clear this price", and a blank
      #   `min_quantity` means the ladder's bottom rung.
      # @return [Spree::ServiceModule::Result] success carries
      #   `{ price_count: N }` — the number of rows passed to `upsert_all`.
      #   Fails with the offending rows when a batch would take a variant
      #   past {Spree::Price::MAXIMUM_BREAKS_PER_VARIANT} breaks on one list:
      #   this path writes in SQL and runs no model validations, so the cap
      #   is enforced here rather than in each of the three controllers that
      #   reach it (docs/plans/6.0-volume-pricing.md).
      def call(rows:)
        rows = Array(rows).map { |r| r.with_indifferent_access }
        keyed = rows.select { |r| r[:variant_id].present? && r[:currency].present? }
        # PG rejects an upsert with two rows hitting the same unique-key
        # triple in one statement ("ON CONFLICT DO UPDATE command cannot
        # affect row a second time"). Last-write-wins: keep the last
        # occurrence of each triple.
        deduped = keyed.reverse.uniq { |r| row_key(r) }.reverse
        upsert_rows, clear_rows = deduped.partition { |r| r[:amount].present? }

        payload = build_payload(upsert_rows)
        affected_keys = deduped.map { |r| row_key(r) }

        return success(price_count: 0) if affected_keys.empty?

        over_cap = ladders_over_cap(upsert_rows)
        return failure(nil, over_cap: over_cap) if over_cap.any?

        base_rows, override_rows = payload.partition { |r| r[:price_list_id].nil? }

        Spree::Price.transaction do
          # MySQL treats NULL values as distinct in unique indexes, so
          # `ON DUPLICATE KEY UPDATE` never fires for base prices —
          # `upsert_all` would silently insert a sibling row. Route base
          # rows through a SELECT-then-UPDATE/INSERT path on MySQL only.
          if base_rows.any? && mysql?
            upsert_base_rows_for_mysql(base_rows)
          else
            upsert_batch(base_rows, BASE_UNIQUE_BY)
          end
          upsert_batch(override_rows, OVERRIDE_UNIQUE_BY)
          sweep(affected_keys, clear_rows)
          # `upsert_all` and `delete_all` both skip AR callbacks, so the
          # `Price -> Variant -> Product` `touch:` chain never fires —
          # downstream caches (`cache_key_with_version`) would stay stale.
          # Re-trigger the chain with one `.touch` per affected variant.
          touch_variants(affected_keys.map { |k| k[0] }.uniq)
        end

        success(price_count: payload.length)
      end

      private

      # `update_only` lists only domain columns. Rails adds `updated_at`
      # automatically (when `record_timestamps` is on, which it is for
      # `Spree::Price`); listing it explicitly here produces
      # `SET updated_at = …, updated_at = …` on PG and the statement fails
      # with "multiple assignments to same column".
      def upsert_batch(rows, unique_by)
        return if rows.empty?

        Spree::Price.upsert_all(
          rows,
          update_only: %i[amount compare_at_amount],
          **upsert_opts(unique_by)
        )
      end

      def build_payload(rows)
        now = Time.current
        rows.map do |row|
          {
            variant_id: row[:variant_id],
            currency: row[:currency],
            price_list_id: row[:price_list_id],
            min_quantity: quantity_of(row),
            amount: parse_amount(row[:amount]),
            compare_at_amount: parse_amount(row[:compare_at_amount]),
            created_at: now,
            updated_at: now
          }
        end
      end

      # A row identifies one rung of one ladder. Rows arriving without a
      # quantity address the bottom rung, which is every row written before
      # breaks existed (docs/plans/6.0-volume-pricing.md).
      def row_key(row)
        [row[:variant_id], row[:currency], row[:price_list_id], quantity_of(row)]
      end

      def quantity_of(row)
        quantity = row[:min_quantity].to_i
        quantity.positive? ? quantity : 1
      end

      # Which ladders this batch would take past the cap, counted the way the
      # constant is named: breaks *above* the bottom rung, so a variant priced
      # at one figure plus ten breaks is exactly at the limit.
      #
      # Only ladders the batch actually adds a break to are checked, so an
      # ordinary spreadsheet save — one quantity-1 row per variant — costs no
      # extra queries at all.
      #
      # @param rows [Array<Hash>] the rows carrying an amount
      # @return [Array<Hash>] `[{ variant_id:, currency:, price_list_id: }, ...]`
      def ladders_over_cap(rows)
        touched = rows.
                  reject { |row| row[:price_list_id].blank? || quantity_of(row) == 1 }.
                  group_by { |row| [row[:variant_id].to_s, row[:currency], row[:price_list_id].to_s] }.
                  transform_values { |group| group.map { |row| quantity_of(row) }.to_set }
        return [] if touched.empty?

        # One query for every ladder in the batch rather than one each: an
        # import writing a ladder across two hundred variants would otherwise
        # issue two hundred round trips inside the request. Cross-pairs the
        # `IN` clauses pull in are dropped by the lookup below, the same way
        # #sweep handles them.
        stored = Spree::Price.
                 where(variant_id: touched.keys.map { |key| key[0] },
                       currency: touched.keys.map { |key| key[1] },
                       price_list_id: touched.keys.map { |key| key[2] }).
                 breaks.
                 pluck(:variant_id, :currency, :price_list_id, :min_quantity).
                 group_by { |variant_id, currency, price_list_id, _| [variant_id.to_s, currency, price_list_id.to_s] }

        touched.filter_map do |key, incoming|
          rungs = stored.fetch(key, []).map(&:last).to_set | incoming
          next if rungs.size <= Spree::Price::MAXIMUM_BREAKS_PER_VARIANT

          { variant_id: key[0], currency: key[1], price_list_id: key[2] }
        end
      end

      # Parses locale-aware decimal input ("1.234,56" in DE, "1,234.56"
      # in en-US). Numeric values pass through; blank values become nil.
      def parse_amount(value)
        return nil if value.blank?
        return value if value.is_a?(Numeric)

        Spree::LocalizedNumber.parse(value)
      end

      def sweep(affected_keys, clear_rows)
        cleared_keys = clear_rows.map { |r| row_key(r) }.to_set
        affected_set = affected_keys.to_set

        candidates = Spree::Price
          .where(
            variant_id: affected_keys.map { |k| k[0] }.uniq,
            currency: affected_keys.map { |k| k[1] }.uniq,
            price_list_id: affected_keys.map { |k| k[2] }.uniq,
            min_quantity: affected_keys.map { |k| k[3] }.uniq
          )
          .pluck(:id, :variant_id, :currency, :price_list_id, :min_quantity, :amount)

        doomed_ids = candidates.filter_map do |id, variant_id, currency, price_list_id, min_quantity, amount|
          key = [variant_id, currency, price_list_id, min_quantity]
          next unless affected_set.include?(key)
          next id if amount.nil?
          next id if cleared_keys.include?(key)

          nil
        end

        Spree::Price.where(id: doomed_ids).delete_all if doomed_ids.any?
      end

      # Bumps `updated_at` on the affected variants and their parent
      # products to invalidate `cache_key_with_version`-based caches —
      # `upsert_all` and `delete_all` skip the `Price -> Variant` and
      # `Variant -> Product` `touch:` chains otherwise.
      #
      # We use `touch_all` rather than per-record `Variant#touch`: it bumps
      # every affected row in a single UPDATE and skips AR callbacks, giving
      # the cache bust without extra side effects.
      def touch_variants(variant_ids)
        return if variant_ids.empty?

        variants = Spree::Variant.where(id: variant_ids)
        product_ids = variants.pluck(:product_id).uniq
        variants.touch_all
        Spree::Product.where(id: product_ids).touch_all if product_ids.any?
      end

      # MySQL infers conflict targets from its own unique indexes and
      # rejects an explicit `unique_by`.
      def upsert_opts(unique_by)
        return {} if mysql?

        { unique_by: unique_by }
      end

      def mysql?
        Spree.mysql?
      end

      # MySQL-only path: NULLs are distinct in unique indexes, so
      # `(variant_id, currency, NULL)` doesn't conflict with another
      # `(variant_id, currency, NULL)` — `upsert_all` would insert a
      # sibling instead of updating. Look up existing base rows first,
      # update them one by one, and `insert_all` the rest.
      def upsert_base_rows_for_mysql(rows)
        rows_by_key = rows.index_by { |r| [r[:variant_id], r[:currency]] }

        Spree::Price.where(
          variant_id: rows.map { |r| r[:variant_id] }.uniq,
          currency: rows.map { |r| r[:currency] }.uniq,
          price_list_id: nil
        ).find_each do |price|
          # The `IN (...)` query can return cross-pairs (e.g. `v=1,c=EUR`
          # exists in the DB even though the caller only passed `v=1,c=USD`
          # and `v=2,c=EUR`). Skip rows the caller didn't request.
          row = rows_by_key.delete([price.variant_id, price.currency])
          next unless row

          price.update_columns(
            amount: row[:amount],
            compare_at_amount: row[:compare_at_amount],
            updated_at: row[:updated_at]
          )
        end

        Spree::Price.insert_all(rows_by_key.values) if rows_by_key.any?
      end
    end
  end
end
