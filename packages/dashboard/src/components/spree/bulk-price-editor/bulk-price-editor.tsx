import type { PriceBulkUpsertRow } from '@spree/admin-sdk'
import {
  adminClient,
  currencyParts,
  normalizeMoneyInput,
  useResourceKey,
} from '@spree/dashboard-core'
import { type BulkPriceRow, BulkPriceTable, toastManager } from '@spree/dashboard-ui'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrencyLocale } from '../../../hooks/use-currency-locale'
import { useBulkUpsertPrices } from '../../../hooks/use-prices'
import { MAXIMUM_QUANTITY_TIERS } from '../../../schemas/price-list'
import { VariantTierDialog } from './variant-tier-dialog'

const PAGE_SIZE = 50
// The API caps a page at 100 rows, so the break sweep asks for exactly that
// and pages until it has them all — at most one page per ten variants on
// screen, since a variant carries at most ten breaks.
const BREAK_PAGE_SIZE = 100
const MAX_BREAK_PAGES = Math.ceil((PAGE_SIZE * MAXIMUM_QUANTITY_TIERS) / BREAK_PAGE_SIZE)

interface PriceListRowFromServer {
  id: string
  variant_id: string
  min_quantity: number
  amount: string | null
  compare_at_amount: string | null
  variant?: {
    product_id?: string
    product_name?: string
    options_text?: string | null
    sku?: string | null
  }
}

interface CellEdit {
  // Stash the variantId at write time. Without it, edits made on page 2
  // would lose their identifier as soon as the user paginates back to
  // page 1: the save loop resolves variant_id via `baselineRows`, which
  // only holds the current page's server result.
  variantId: string
  amount: string | null
  compareAt: string | null
}

// BulkPriceRow extended with the server-side variantId so save can ship
// the canonical (variant_id, currency, price_list_id) upsert triple.
interface BaselineRow extends BulkPriceRow {
  priceId?: string
  variantId?: string
  /** Shown in the tier dialog's title, so the merchant knows which row. */
  tierLabel?: string
}

type FilterShape = Record<string, string | number | boolean | string[] | null | undefined>

// Strip predicates the editor owns + drop empty values, then serialize
// in a key-sorted form so reference churn from the parent doesn't
// trigger spurious refetches / edits resets but real shape changes do.
function sanitizeFilter(filter: FilterShape | undefined): FilterShape {
  if (!filter) return {}
  const out: FilterShape = {}
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('price_list_id')) continue
    if (v === undefined || v === null || v === '') continue
    // An empty list is not a filter — Ransack reads `field_in: []` as
    // "match nothing" and would blank the grid.
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

function stableFilterKey(filter: FilterShape): string {
  const entries = Object.entries(filter).sort(([a], [b]) => a.localeCompare(b))
  return entries.length === 0 ? '' : JSON.stringify(entries)
}

export interface BulkPriceEditorProps {
  /** Filter by a specific price list. Omit to edit base prices. */
  priceListId?: string
  currency: string
  /** Extra Ransack predicates spread into the index call — e.g.
   *  `{ variant_product_id_eq: 'prod_xxx' }` for a per-product editor.
   *  Keys starting with `price_list_id` are stripped (the editor owns
   *  that predicate via `priceListId`). Memoize in the parent to avoid
   *  refetch + edits-reset churn on every render. */
  filter?: FilterShape
  /** Notifies the parent of dirty count + save handle so the route can
   *  render a sticky footer bar and a router-leave guard. */
  onStateChange?: (state: BulkPriceEditorState) => void
}

export interface BulkPriceEditorState {
  dirtyCount: number
  saving: boolean
  /** Resolves to `true` if the upsert succeeded, `false` on error (the
   *  editor already toasted) or no-op (nothing dirty). Lets the dialog
   *  decide whether to close without inspecting post-save state. */
  save: () => Promise<boolean>
  discard: () => void
}

/**
 * Server-backed prices spreadsheet. Reads via `GET /admin/prices?…&expand=variant`
 * (server-side pagination, SKU search) and saves via
 * `POST /admin/prices/bulk_upsert`. Filters are owned by the caller so
 * the same component drives both the "edit one price list" route and a
 * "edit base prices for one product" dialog. Presentation is delegated
 * to `<BulkPriceTable>` from `@spree/dashboard-ui`.
 */
export function BulkPriceEditor({
  priceListId,
  currency,
  filter,
  onStateChange,
}: BulkPriceEditorProps) {
  const { t } = useTranslation()
  // Destructure the stable handles off `useMutation` (mutateAsync is
  // stable across renders; the wrapper object is not). Closing over the
  // wrapper would put a fresh reference in every callback's dep array
  // and tank the parent via the `onStateChange` effect below.
  const { mutateAsync: bulkUpsertAsync, isPending: isSaving } = useBulkUpsertPrices()
  const localeForCurrency = useCurrencyLocale()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)

  const sanitizedFilter = useMemo(() => sanitizeFilter(filter), [filter])
  const filterKey = useMemo(() => stableFilterKey(sanitizedFilter), [sanitizedFilter])

  // Format the grid in the currency's market locale (e.g. EUR → `de`, comma
  // decimal). The same locale normalizes amounts to canonical form on save (see
  // `save`), so what the merchant types matches what the API receives. Falls
  // back to `en` (canonical period-decimal), NOT the UI language — money
  // formatting/parsing must never depend on the dashboard's language.
  const marketLocale = localeForCurrency(currency) || 'en'
  const { symbol, decimal } = useMemo(
    () => currencyParts(currency, marketLocale),
    [currency, marketLocale],
  )

  const { data, isLoading } = useQuery({
    queryKey: useResourceKey('prices', {
      priceListId: priceListId ?? null,
      currency,
      filter: filterKey,
      page,
      q: deferredSearch,
    }),
    queryFn: () =>
      adminClient.prices.list({
        // Caller-supplied predicates first, then the editor's own — the
        // sanitizer above strips any `price_list_id_*` keys so callers
        // can't override our scope distinction.
        ...sanitizedFilter,
        ...(priceListId ? { price_list_id_eq: priceListId } : { price_list_id_null: true }),
        currency_eq: currency,
        // One row per variant: the deeper rungs of a ladder are edited in
        // the tier dialog, not as extra lines that read like duplicates
        // (docs/plans/6.0-volume-pricing.md).
        min_quantity_eq: 1,
        // `search` is a Ransack-whitelisted scope on Price that ORs
        // across the variant's SKU, parent product name, and option-value
        // presentations ("Red", "XL", …). 3-char floor lives in the scope.
        search: deferredSearch || undefined,
        expand: 'variant',
        page,
        limit: PAGE_SIZE,
        sort: 'variant_product_name,variant_id',
      } as never),
    enabled: !!currency,
  })

  const totalPages = data?.meta?.pages ?? 1
  const totalCount = data?.meta?.count ?? 0

  const pageVariantIds = useMemo(
    () =>
      ((data?.data ?? []) as unknown as PriceListRowFromServer[])
        .map((row) => row.variant_id)
        .filter(Boolean),
    [data],
  )

  // The rungs above the bottom one, for this page's variants only — a few
  // queries rather than one per row, and none at all when this editor has no
  // list to hold a ladder (docs/plans/6.0-volume-pricing.md).
  //
  // Paged rather than asked for in one call: a page of fifty fully-laddered
  // variants is five hundred rows and the API caps a page at a hundred, so a
  // single request would silently truncate and under-report the badges.
  const { data: breakRows } = useQuery({
    queryKey: useResourceKey('prices', {
      breaks: priceListId ?? null,
      currency,
      variants: pageVariantIds.join(','),
    }),
    queryFn: async () => {
      const collected: PriceListRowFromServer[] = []
      let breakPage = 1
      let lastPage: number

      do {
        const response = await adminClient.prices.list({
          variant_id_in: pageVariantIds,
          price_list_id_eq: priceListId,
          currency_eq: currency,
          min_quantity_gt: 1,
          page: breakPage,
          limit: BREAK_PAGE_SIZE,
        } as never)

        collected.push(...(response.data as unknown as PriceListRowFromServer[]))
        lastPage = response.meta?.pages ?? 1
        breakPage += 1
        // Bounded: a page of variants can hold at most PAGE_SIZE ladders of
        // MAXIMUM_QUANTITY_TIERS rungs, so anything beyond that is a server
        // answering something this loop should not chase.
      } while (breakPage <= lastPage && breakPage <= MAX_BREAK_PAGES)

      return collected
    },
    enabled: !!priceListId && pageVariantIds.length > 0,
  })

  const breakCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of breakRows ?? []) {
      counts.set(row.variant_id, (counts.get(row.variant_id) ?? 0) + 1)
    }
    return counts
  }, [breakRows])

  const baselineRows = useMemo<BaselineRow[]>(() => {
    if (!data) return []
    const out: BaselineRow[] = []
    let lastProductId: string | null = null
    for (const row of data.data as unknown as PriceListRowFromServer[]) {
      const variant = row.variant ?? {}
      if (variant.product_id && variant.product_id !== lastProductId) {
        out.push({
          id: `header:${variant.product_id}`,
          kind: 'header',
          groupLabel: variant.product_name,
        })
        lastProductId = variant.product_id
      }
      out.push({
        id: row.id,
        kind: 'item',
        priceId: row.id,
        variantId: row.variant_id,
        variantLabel: variant.options_text ?? null,
        tierLabel: [variant.product_name, variant.options_text].filter(Boolean).join(' — '),
        sku: variant.sku ?? null,
        amount: row.amount,
        compareAt: row.compare_at_amount,
        breakCount: breakCounts.get(row.variant_id) ?? 0,
      })
    }
    return out
  }, [data, breakCounts])

  const [edits, setEdits] = useState<Map<string, CellEdit>>(() => new Map())
  // Which row's ladder is open. Held by row id rather than variant id so the
  // dialog can name the product the merchant clicked.
  const [tierRowId, setTierRowId] = useState<string | null>(null)

  // Reset page + edits whenever the upstream filters change — a different
  // list, currency, or product scope is a different working set; carrying
  // old edits across would be confusing and could collide on the
  // bulk-upsert ids.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is bound to filter identity
  useEffect(() => {
    setPage(1)
    setEdits(new Map())
  }, [priceListId, currency, filterKey])

  const rows = useMemo<BulkPriceRow[]>(
    () =>
      baselineRows.map((r) => {
        if (r.kind !== 'item' || !r.priceId) return r
        const edit = edits.get(r.priceId)
        if (!edit) return r
        return { ...r, amount: edit.amount, compareAt: edit.compareAt }
      }),
    [baselineRows, edits],
  )

  const handleChange = useCallback(
    (rowId: string, field: 'amount' | 'compareAt', next: string | null) => {
      setEdits((prev) => {
        const baseline = baselineRows.find(
          (r): r is BaselineRow & { kind: 'item' } => r.kind === 'item' && r.priceId === rowId,
        )
        if (!baseline?.variantId) return prev
        // Baseline is the API's canonical decimal (`12.50`); the cell
        // ships the user's raw locale-formatted input (`12,50`). Seed the
        // baseline in display form so an untouched field naturally matches
        // when the other field is edited — otherwise an edit to `compareAt`
        // alone would falsely mark `amount` dirty under a comma-decimal locale.
        const displayBaseAmount = baseline.amount ? baseline.amount.replace('.', decimal) : null
        const displayBaseCompare = baseline.compareAt
          ? baseline.compareAt.replace('.', decimal)
          : null
        const current = prev.get(rowId) ?? {
          variantId: baseline.variantId,
          amount: displayBaseAmount,
          compareAt: displayBaseCompare,
        }
        const merged = { ...current, [field]: next }
        if (merged.amount === displayBaseAmount && merged.compareAt === displayBaseCompare) {
          const out = new Map(prev)
          out.delete(rowId)
          return out
        }
        const out = new Map(prev)
        out.set(rowId, merged)
        return out
      })
    },
    [baselineRows, decimal],
  )

  const save = useCallback(async (): Promise<boolean> => {
    if (edits.size === 0) return false
    // Snapshot the keys we're about to ship; cells stay editable while
    // the mutation is in-flight, so concurrent edits the user makes
    // during the round-trip must survive the post-save clear. After a
    // successful upsert we drop only the keys that were in the snapshot.
    const savedKeys = Array.from(edits.keys())
    // Ship the unique-key triple `(variant_id, currency, price_list_id)`
    // — that's what the server upserts on. `id` is not used by the bulk
    // endpoint; we already have the lookup columns on screen so there's
    // no point making the server backfill them.
    // Normalize each amount from the grid's display locale (the currency's
    // market locale, e.g. EUR → `de`) into the canonical `"1234.56"` the API
    // expects. The server is never asked to parse comma-vs-period — see
    // docs/plans/5.5-client-side-money-normalization.md.
    const toCanonical = (v: string | null) => {
      if (v == null) return null
      const normalized = normalizeMoneyInput(v, marketLocale || 'en')
      return normalized === '' ? null : normalized
    }
    const payload: PriceBulkUpsertRow[] = savedKeys.map((priceId) => {
      const edit = edits.get(priceId) as CellEdit
      return {
        variant_id: edit.variantId,
        currency,
        ...(priceListId ? { price_list_id: priceListId } : {}),
        amount: toCanonical(edit.amount),
        compare_at_amount: toCanonical(edit.compareAt),
      }
    })
    try {
      const res = await bulkUpsertAsync({ prices: payload })
      toastManager.add({
        type: 'success',
        title: t('admin.pages.products.price_lists.edit_prices.save_success', {
          count: res.price_count,
        }),
      })
      setEdits((prev) => {
        const out = new Map(prev)
        for (const key of savedKeys) out.delete(key)
        return out
      })
      return true
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('admin.pages.products.price_lists.edit_prices.save_failed')
      toastManager.add({ type: 'error', title: message })
      return false
    }
  }, [edits, currency, priceListId, bulkUpsertAsync, marketLocale, t])

  const discard = useCallback(() => {
    setEdits(new Map())
  }, [])

  // Surface dirty/save/discard to the parent route so it can render a
  // sticky footer and gate router navigation on unsaved edits.
  useEffect(() => {
    onStateChange?.({ dirtyCount: edits.size, saving: isSaving, save, discard })
  }, [edits.size, isSaving, save, discard, onStateChange])

  const countSummary =
    totalCount > 0
      ? t('admin.pages.products.price_lists.edit_prices.count_summary', {
          count: totalCount,
          currency,
        })
      : t('admin.pages.products.price_lists.edit_prices.no_matches_for_filters')

  const emptyMessage = priceListId
    ? t('admin.pages.products.price_lists.edit_prices.empty_pick_products')
    : t('admin.pages.products.price_lists.edit_prices.empty_no_base_prices')

  const emptySearchMessage = t(
    'admin.pages.products.price_lists.edit_prices.no_matches_for_search',
    { search },
  )

  const tierRow = tierRowId
    ? baselineRows.find((row) => row.kind === 'item' && row.id === tierRowId)
    : undefined

  return (
    <>
      <BulkPriceTable
        rows={rows}
        symbol={symbol}
        decimal={decimal}
        onChange={handleChange}
        // Ladders live on a price list; base prices carry no breaks in v1, so
        // the column simply does not appear there.
        onOpenTiers={priceListId ? setTierRowId : undefined}
        search={search}
        onSearchChange={(next) => {
          setSearch(next)
          setPage(1)
        }}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        isLoading={isLoading}
        labels={{
          variant: t('admin.pages.products.price_lists.edit_prices.columns.variant'),
          sku: t('admin.pages.products.price_lists.edit_prices.columns.sku'),
          price: t('admin.pages.products.price_lists.edit_prices.columns.price'),
          compareAt: t('admin.pages.products.price_lists.edit_prices.columns.compare_at_price'),
          variantDefault: t('admin.pages.products.price_lists.edit_prices.variant_default'),
          searchPlaceholder: t('admin.pages.products.price_lists.edit_prices.search_placeholder'),
          countSummary,
          loading: t('admin.common.loading'),
          pageOf: t('admin.common.page_of', { page: '{page}', total: '{total}' }),
          prev: t('admin.common.prev'),
          next: t('admin.common.next'),
          emptyMessage,
          emptySearchMessage,
          gridAriaLabel: t('admin.pages.products.price_lists.edit_prices.grid_aria'),
          priceAriaTemplate: t('admin.pages.products.price_lists.edit_prices.price_aria', {
            label: '{label}',
          }),
          compareAtAriaTemplate: t('admin.pages.products.price_lists.edit_prices.compare_at_aria', {
            label: '{label}',
          }),
          tiers: priceListId
            ? t('admin.pages.products.price_lists.edit_prices.columns.tiers')
            : undefined,
          tiersWithCount: (count: number) =>
            t('admin.pages.products.price_lists.tiers.count_badge', { count }),
          tiersEmpty: t('admin.pages.products.price_lists.tiers.add_short'),
        }}
      />

      {priceListId && tierRow?.variantId && (
        <VariantTierDialog
          open
          onOpenChange={(next) => {
            if (!next) setTierRowId(null)
          }}
          variantId={tierRow.variantId}
          variantLabel={
            tierRow.tierLabel || t('admin.pages.products.price_lists.edit_prices.variant_default')
          }
          priceListId={priceListId}
          currency={currency}
          decimal={decimal}
          marketLocale={marketLocale}
          symbol={symbol}
        />
      )}
    </>
  )
}
