import type { CatalogPrice, CatalogProduct } from '@spree/admin-sdk'
import type { ProductMembershipRow } from '@spree/dashboard-ui'
import {
  Badge,
  TableCell,
  TableHead,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@spree/dashboard-ui'
import i18n from 'i18next'

const AGREEMENT_SOURCES = ['explicit', 'automatic'] as const

/**
 * What the agreement charges, as columns on the assortment rows.
 *
 * The source is the reason these columns exist: an amount on its own cannot
 * tell a merchant whether their catalog actually prices a product or is
 * quietly falling through to the shop price. A `base` row is exactly that
 * divergence — in the assortment, priced by nothing the agreement says
 * (docs/plans/6.0-catalog-agreement-rework.md).
 *
 * A staged addition has no resolved price yet — it does not exist server-side
 * until Save — so it says so rather than borrowing another row's number. A
 * staged removal keeps showing its price: it is still on the list until Save,
 * and the struck-through row already says it is leaving.
 */
export function catalogPriceColumns({
  products,
  headers,
}: {
  /** The server rows this page rendered, which carry the resolved price. */
  products: CatalogProduct[]
  headers: {
    price: string
    source: string
  }
}) {
  const byId = new Map(products.map((product) => [product.id, product.catalog_price]))

  return {
    headers: (
      <>
        <TableHead className="w-32 text-right">{headers.price}</TableHead>
        <TableHead className="w-28">{headers.source}</TableHead>
      </>
    ),
    renderCells: (row: ProductMembershipRow) => {
      const price = row.pending === 'added' ? undefined : byId.get(row.id)

      return (
        <>
          <TableCell className="text-right tabular-nums">
            {price ? (
              <span className="inline-flex items-center justify-end gap-1.5">
                {price.display_amount}
                {/* What the agreement charges for one unit, with the tiers
                    above it counted rather than hidden — a single figure on a
                    laddered variant reads as the only price there is
                    (docs/plans/6.0-volume-pricing.md). */}
                {price.break_count > 0 && <TierBadge price={price} />}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {row.pending === 'added'
                  ? i18n.t('admin.catalogs.prices.after_save')
                  : i18n.t('admin.catalogs.prices.unpriced')}
              </span>
            )}
          </TableCell>
          <TableCell>{price && <PriceSourceBadge source={price.source} />}</TableCell>
        </>
      )
    },
  }
}

/**
 * A price the agreement decided reads as an ordinary fact; one falling
 * through to the shop price is called out, because a merchant looking at a
 * catalog has every reason to assume it prices what it lists.
 */
function PriceSourceBadge({ source }: { source: string }) {
  const fromAgreement = (AGREEMENT_SOURCES as readonly string[]).includes(source)
  const help = i18n.t(`admin.catalogs.prices.source_help.${source}`)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable and named, so the explanation opens on focus as well as
            hover — the same reason the terms columns wrap theirs. */}
        <button type="button" className="cursor-help rounded-sm" aria-label={help}>
          <Badge variant={fromAgreement ? 'secondary' : 'outline'}>
            {i18n.t(`admin.catalogs.prices.source.${source}`)}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{help}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The count of a variant's quantity tiers, with the ladder itself on hover.
 *
 * The count alone asks a merchant to open the price sheet to read three
 * figures, which is a click to answer a question the row could just answer
 * (docs/plans/6.0-volume-pricing.md).
 */
function TierBadge({ price }: { price: CatalogPrice }) {
  const label = i18n.t('admin.catalogs.prices.tier_count', { count: price.break_count })

  // Nothing to preview — either the resolver could not price the rungs, or
  // the response predates the field (a client holding a cached page across
  // a deploy). Either way the badge stays a plain statement of fact rather
  // than taking the row down with it.
  const tiers = price.tiers ?? []
  if (tiers.length === 0) {
    return (
      <Badge variant="outline" className="font-normal">
        {label}
      </Badge>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-help rounded-sm">
          <Badge variant="outline" className="font-normal">
            {label}
          </Badge>
        </button>
      </TooltipTrigger>
      {/* TooltipContent is an inline-flex row capped at 200px, which lays a
          heading beside a table and wraps both. A ladder is a block: stack it
          and let it size to its figures. */}
      <TooltipContent className="max-w-none flex-col items-stretch gap-0 px-2.5 py-2 text-left">
        <p className="mb-1.5 whitespace-nowrap font-medium">
          {i18n.t('admin.catalogs.prices.tier_preview')}
        </p>
        <table className="text-xs tabular-nums">
          <tbody>
            {/* The variant's own price is the ladder's first rung, so the
                preview opens with it rather than starting at the first
                break — otherwise the cheapest figure reads as the price. */}
            <tr>
              <td className="whitespace-nowrap pr-4 text-muted-foreground">
                {i18n.t('admin.catalogs.prices.tier_from', { count: 1 })}
              </td>
              <td className="whitespace-nowrap text-right">{price.display_amount}</td>
            </tr>
            {tiers.map((tier) => (
              <tr key={tier.min_quantity}>
                <td className="whitespace-nowrap pr-4 text-muted-foreground">
                  {i18n.t('admin.catalogs.prices.tier_from', { count: tier.min_quantity })}
                </td>
                <td className="whitespace-nowrap text-right">{tier.display_amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  )
}
