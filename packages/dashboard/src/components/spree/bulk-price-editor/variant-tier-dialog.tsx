import type { PriceBulkUpsertRow } from '@spree/admin-sdk'
import { adminClient, normalizeMoneyInput, useResourceKey } from '@spree/dashboard-core'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  QuantityTierEditor,
  type QuantityTierRow,
  toastManager,
} from '@spree/dashboard-ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBulkUpsertPrices } from '../../../hooks/use-prices'
import { MAXIMUM_QUANTITY_TIERS } from '../../../schemas/price-list'

interface StoredRung {
  id: string
  min_quantity: number
  amount: string | null
}

interface DraftRung extends QuantityTierRow {
  /** The stored row this rung came from, absent for one the merchant added. */
  priceId?: string
}

export interface VariantTierDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** The variant whose ladder this is, as a prefixed id. */
  variantId: string
  /** Shown in the title so the merchant knows which row they opened. */
  variantLabel: string
  priceListId: string
  currency: string
  /** Decimal separator of the currency's market locale, for display. */
  decimal: string
  /** The locale amounts are normalized back through on save. */
  marketLocale: string
  symbol: string
}

/**
 * One variant's quantity ladder on one price list: the rungs it is charged at
 * as an order grows (docs/plans/6.0-volume-pricing.md).
 *
 * Opened from the price spreadsheet's tier column, and saved on its own
 * rather than with the grid — a ladder is a shape, not a cell, and half of
 * one is not a state worth persisting.
 */
export function VariantTierDialog({
  open,
  onOpenChange,
  variantId,
  variantLabel,
  priceListId,
  currency,
  decimal,
  marketLocale,
  symbol,
}: VariantTierDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const rowIdPrefix = useId()
  const { mutateAsync: bulkUpsertAsync, isPending: isSaving } = useBulkUpsertPrices()
  const [draft, setDraft] = useState<DraftRung[]>([])
  const [nextLocalId, setNextLocalId] = useState(0)

  const queryKey = useResourceKey('prices', { ladder: variantId, priceListId, currency })
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      adminClient.prices.list({
        variant_id_eq: variantId,
        price_list_id_eq: priceListId,
        currency_eq: currency,
        sort: 'min_quantity',
        limit: MAXIMUM_QUANTITY_TIERS + 1,
      } as never),
    enabled: open,
  })

  const stored = useMemo<StoredRung[]>(() => (data?.data ?? []) as unknown as StoredRung[], [data])

  // Seeded once per opening, not on every change to `stored`: TanStack
  // refetches on window focus, and re-seeding from that would discard a
  // half-typed ladder the moment the merchant tabbed away and back. Closing
  // and reopening is what re-reads the server.
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      seededFor.current = null
      return
    }
    if (isLoading || seededFor.current === variantId) return

    seededFor.current = variantId
    setDraft(
      stored.map((rung) => ({
        id: `${rowIdPrefix}-stored-${rung.id}`,
        priceId: rung.id,
        minQuantity: String(rung.min_quantity),
        value: rung.amount ? rung.amount.replace('.', decimal) : '',
        // The bottom rung is the list's ordinary price for this variant. It
        // is edited in the grid behind this dialog; here it is only context
        // for the rungs above it.
        locked: rung.min_quantity === 1,
      })),
    )
  }, [open, isLoading, stored, decimal, rowIdPrefix, variantId])

  const toCanonical = (value: string) => {
    const normalized = normalizeMoneyInput(value, marketLocale || 'en')
    return normalized === '' ? null : normalized
  }

  const invalidRung = draft.find((rung) => {
    if (rung.locked) return false
    const quantity = Number(rung.minQuantity)
    return !Number.isInteger(quantity) || quantity < 2 || toCanonical(rung.value) === null
  })
  // Compared as numbers: "10" and "010" address the same rung, and letting
  // both through means the batch silently keeps one and drops the other.
  const duplicateQuantity =
    new Set(draft.map((rung) => Number(rung.minQuantity))).size !== draft.length

  async function handleSave() {
    const upserts: PriceBulkUpsertRow[] = draft
      .filter((rung) => !rung.locked)
      .map((rung) => ({
        variant_id: variantId,
        currency,
        price_list_id: priceListId,
        min_quantity: Number(rung.minQuantity),
        amount: toCanonical(rung.value),
      }))

    // A rung is identified by its quantity, not by the row it came from:
    // moving a break from 24 to 30 writes a new row, so keying the removals on
    // the row id would leave the 24 behind and charge it to orders of 24-29
    // (docs/plans/6.0-volume-pricing.md).
    const keptQuantities = new Set(upserts.map((rung) => rung.min_quantity))

    // Removals ride in the same batch as a blank amount, which is what the
    // bulk endpoint reads as "clear this price". One request rather than two:
    // the server then sees the whole ladder at once, so it neither refuses a
    // rewrite for rungs it is about to drop nor leaves the ladder half erased
    // when a write is refused.
    const removals: PriceBulkUpsertRow[] = stored
      .filter((rung) => rung.min_quantity > 1 && !keptQuantities.has(rung.min_quantity))
      .map((rung) => ({
        variant_id: variantId,
        currency,
        price_list_id: priceListId,
        min_quantity: rung.min_quantity,
        amount: null,
      }))

    try {
      await bulkUpsertAsync({ prices: [...upserts, ...removals] })

      await queryClient.invalidateQueries({ queryKey: ['prices'] })
      toastManager.add({
        type: 'success',
        title: t('admin.pages.products.price_lists.tiers.save_success', { count: upserts.length }),
      })
      onOpenChange(false)
    } catch (error) {
      toastManager.add({
        type: 'error',
        title:
          error instanceof Error
            ? error.message
            : t('admin.pages.products.price_lists.tiers.save_failed'),
      })
    }
  }

  const tierCount = draft.filter((rung) => !rung.locked).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('admin.pages.products.price_lists.tiers.title', { variant: variantLabel })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('admin.common.loading')}</p>
          ) : (
            <QuantityTierEditor
              rows={draft}
              labels={{
                quantity: t('admin.pages.products.price_lists.tiers.quantity'),
                value: t('admin.pages.products.price_lists.tiers.unit_price'),
                add: t('admin.pages.products.price_lists.tiers.add'),
                remove: t('admin.pages.products.price_lists.tiers.remove'),
                empty: t('admin.pages.products.price_lists.tiers.empty'),
                hint: t('admin.pages.products.price_lists.tiers.help'),
              }}
              valueAddon={symbol}
              canAdd={tierCount < MAXIMUM_QUANTITY_TIERS}
              disabled={isSaving}
              error={
                duplicateQuantity
                  ? t('admin.pages.products.price_lists.tiers.duplicate_quantity')
                  : invalidRung
                    ? t('admin.pages.products.price_lists.tiers.invalid_rung')
                    : undefined
              }
              onChange={(id, field, next) =>
                setDraft((prev) =>
                  prev.map((rung) => (rung.id === id ? { ...rung, [field]: next } : rung)),
                )
              }
              onAdd={() => {
                setDraft((prev) => [
                  ...prev,
                  { id: `${rowIdPrefix}-new-${nextLocalId}`, minQuantity: '', value: '' },
                ])
                setNextLocalId((previous) => previous + 1)
              }}
              onRemove={(id) => setDraft((prev) => prev.filter((rung) => rung.id !== id))}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('admin.common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={isSaving || isLoading || !!invalidRung || duplicateQuantity}
          >
            {t('admin.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
