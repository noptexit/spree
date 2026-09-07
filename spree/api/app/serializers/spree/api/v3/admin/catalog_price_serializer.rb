module Spree
  module Api
    module V3
      module Admin
        # What a buyer on one catalog pays for one product, and where that
        # number came from — an explicit amount on the catalog's own list,
        # that list's percentage applied to the base price, or the base price
        # itself, meaning this agreement does not price the product at all
        # (docs/plans/6.0-catalog-agreement-rework.md).
        #
        # Serializes a {Spree::CatalogPrice}, which is resolved rather than
        # stored, so it carries no id.
        class CatalogPriceSerializer < V3::BaseSerializer
          # Resolved rather than stored, so there is no id to carry — and a
          # null one would only invite a client to key on it.
          _attributes.delete(:id)

          typelize amount: :string, display_amount: :string,
                   currency: :string, source: :string, break_count: :number

          # How many quantity tiers sit above this amount, so the view can say
          # "and three more from a case up" rather than showing one figure as
          # though it were the only one.
          attributes :currency, :source, :break_count

          attribute :amount do |price|
            price.amount.to_s
          end

          attribute :display_amount do |price|
            price.display_amount
          end
        end
      end
    end
  end
end
