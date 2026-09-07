module Spree
  # One band of a price list's percentage adjustment: from this quantity up,
  # the list adjusts base prices by this percentage instead of the one on its
  # own `price_adjustment_percentage` column.
  #
  # The column stays the list's quantity-1 value, so a list carrying no tiers
  # prices exactly as it did before bands existed. A band adjusts the *base*
  # price, like the column does — never a previous band's result — so a
  # merchant reading "-20% from fifty" gets twenty percent off the shop price
  # and not twenty percent off an already-discounted number
  # (docs/plans/6.0-volume-pricing.md).
  class PriceAdjustmentTier < Spree.base_class
    has_prefix_id :pat

    # How many bands one list may carry, matching the break cap so a merchant
    # meets one number rather than two.
    MAXIMUM_TIERS_PER_LIST = Spree::Price::MAXIMUM_BREAKS_PER_VARIANT

    belongs_to :price_list, class_name: 'Spree::PriceList', inverse_of: :price_adjustment_tiers, touch: true

    validates :min_quantity, presence: true,
              numericality: { only_integer: true, greater_than: 1 },
              uniqueness: { scope: :price_list_id }
    # The same bounds the list's own column carries: at -100 every derived
    # price is zero, below it the arithmetic goes negative, and above 1000 the
    # decimal(6,3) column cannot hold the value.
    validates :percentage, presence: true,
              numericality: { greater_than: -100, less_than: 1000 }
    validate :tiers_within_cap

    scope :by_quantity, -> { order(min_quantity: :asc) }
    # Bands a line of this size qualifies for, deepest first.
    scope :for_quantity, ->(quantity) { where(min_quantity: ..quantity.to_i).order(min_quantity: :desc) }

    self.whitelisted_ransackable_attributes = %w[min_quantity percentage price_list_id]

    private

    # Quantity 1 is the list's own column, so a band at 1 would be a second
    # answer to a question already answered — refused by the numericality
    # bound above rather than silently shadowing the column.
    def tiers_within_cap
      return if price_list_id.blank?

      siblings = self.class.where(price_list_id: price_list_id)
      siblings = siblings.where.not(id: id) if persisted?
      return if siblings.count < MAXIMUM_TIERS_PER_LIST

      errors.add(:base, :too_many_tiers, count: MAXIMUM_TIERS_PER_LIST)
    end
  end
end
