import { LedgerImbalanceError } from './errors'
import type { OrderSplit } from './split'

export type LedgerEntryType = 'cogs' | 'provider_margin' | 'platform_fee'

export interface LedgerEntryDraft {
  type: LedgerEntryType
  amountCents: number
}

const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = [
  'cogs',
  'provider_margin',
  'platform_fee',
]

export function toLedgerEntries(split: OrderSplit): LedgerEntryDraft[] {
  return [
    { type: 'cogs', amountCents: split.cogsCents },
    { type: 'provider_margin', amountCents: split.providerMarginCents },
    { type: 'platform_fee', amountCents: split.platformFeeCents },
  ]
}

export function assertLedgerBalances(
  entries: readonly LedgerEntryDraft[],
  amountPaidCents: number,
): void {
  const actualCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0)
  const hasEachTypeOnce =
    entries.length === LEDGER_ENTRY_TYPES.length &&
    LEDGER_ENTRY_TYPES.every(
      (type) => entries.filter((entry) => entry.type === type).length === 1,
    )
  const amountsAreValid = entries.every(
    (entry) =>
      Number.isSafeInteger(entry.amountCents) && entry.amountCents >= 0,
  )
  if (hasEachTypeOnce && amountsAreValid && actualCents === amountPaidCents) {
    return
  }
  throw new LedgerImbalanceError(amountPaidCents, actualCents)
}
