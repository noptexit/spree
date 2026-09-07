module Spree
  # What a buyer on one catalog pays for one variant, and where that number
  # came from. Resolved by {Spree::Catalogs::ResolvePrices}; this object is
  # only the answer.
  #
  # The source is the point: an amount alone cannot tell a merchant whether
  # their agreement actually prices a product or is quietly falling through
  # to the shop price (docs/plans/6.0-catalog-agreement-rework.md).
  #
  #   explicit  — an amount someone typed on the catalog's own list
  #   automatic — that list's percentage applied to the base price
  #   base      — the variant's normal price; this agreement does not price it
  class CatalogPrice
    include ActiveModel::Model
    include ActiveModel::Attributes

    # Where a resolved amount came from. A closed set: the reading is only
    # useful if every amount can say which of the three it is.
    SOURCES = %w[explicit automatic base].freeze

    attribute :amount, :decimal
    attribute :currency, :string
    attribute :source, :string
    # How many quantity tiers sit above this amount — breaks on the list's own
    # rows, or bands on its percentage. Zero for a variant priced at one
    # figure whatever the order size (docs/plans/6.0-volume-pricing.md).
    attribute :break_count, :integer, default: 0

    # The ladder itself, as {Spree::CatalogPriceTier} rows ordered by quantity
    # — so a merchant reading the agreement sees what the buyer pays at each
    # threshold without opening the price sheet
    # (docs/plans/6.0-volume-pricing.md).
    attr_writer :tiers

    validates :source, inclusion: { in: SOURCES }

    # @return [Array<Spree::CatalogPriceTier>]
    def tiers
      @tiers ||= []
    end

    # True when the catalog's own pricing decided this amount, rather than the
    # shop price showing through.
    # @return [Boolean]
    def from_agreement?
      source != 'base'
    end

    # Whether the amount is the bottom of a ladder rather than the only price.
    # @return [Boolean]
    def tiered?
      break_count.to_i.positive?
    end

    # @return [Spree::Money]
    def money
      Spree::Money.new(amount, currency: currency)
    end

    # @return [String]
    def display_amount
      money.to_s
    end
  end
end
