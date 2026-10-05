import { describe, expect, it } from 'vitest'
import { LedgerImbalanceError } from './errors'
import {
  assertLedgerBalances,
  toLedgerEntries,
  type LedgerEntryDraft,
} from './ledger'
import type { OrderSplit } from './split'

interface LedgerFailureCase {
  label: string
  entries: readonly LedgerEntryDraft[]
  amountPaidCents: number
}

const EXAMPLE_SPLIT: OrderSplit = {
  subtotalCents: 12000,
  platformFeeCents: 90,
  totalCents: 12090,
  cogsCents: 7000,
  providerMarginCents: 5000,
}

const ZERO_SPLIT: OrderSplit = {
  subtotalCents: 0,
  platformFeeCents: 0,
  totalCents: 0,
  cogsCents: 0,
  providerMarginCents: 0,
}

const ZERO_MARGIN_SPLIT: OrderSplit = {
  subtotalCents: 800,
  platformFeeCents: 6,
  totalCents: 806,
  cogsCents: 800,
  providerMarginCents: 0,
}

function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (caught: unknown) {
    return caught
  }
  return undefined
}

function sumAmounts(entries: readonly LedgerEntryDraft[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0)
}

// expectedCents is the payment the ledger is checked against. actualCents is the
// arithmetic sum of the supplied amounts, even when the sums match and the throw
// is structural (missing, duplicate, extra, negative, or non-integer). A missing
// zero-amount type is not treated as zero. The entry has to be present.
function expectImbalance(
  entries: readonly LedgerEntryDraft[],
  amountPaidCents: number,
): void {
  const thrown = thrownBy(() => {
    assertLedgerBalances(entries, amountPaidCents)
  })
  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).toBeInstanceOf(LedgerImbalanceError)
  if (!(thrown instanceof LedgerImbalanceError)) {
    return
  }
  expect(thrown.name).toBe('LedgerImbalanceError')
  expect(Object.is(thrown.expectedCents, amountPaidCents)).toBe(true)
  expect(Object.is(thrown.actualCents, sumAmounts(entries))).toBe(true)
}

describe('toLedgerEntries', () => {
  it('returns cogs, provider margin, and platform fee in that order', () => {
    expect(toLedgerEntries(EXAMPLE_SPLIT)).toEqual([
      { type: 'cogs', amountCents: 7000 },
      { type: 'provider_margin', amountCents: 5000 },
      { type: 'platform_fee', amountCents: 90 },
    ])
  })

  it('keeps a zero provider-margin entry', () => {
    expect(toLedgerEntries(ZERO_MARGIN_SPLIT)).toEqual([
      { type: 'cogs', amountCents: 800 },
      { type: 'provider_margin', amountCents: 0 },
      { type: 'platform_fee', amountCents: 6 },
    ])
  })

  it('keeps zero-amount entries for an all-zero split', () => {
    expect(toLedgerEntries(ZERO_SPLIT)).toEqual([
      { type: 'cogs', amountCents: 0 },
      { type: 'provider_margin', amountCents: 0 },
      { type: 'platform_fee', amountCents: 0 },
    ])
  })
})

describe('assertLedgerBalances', () => {
  it('accepts the three entries of a paid order', () => {
    const entries = toLedgerEntries(EXAMPLE_SPLIT)
    expect(
      assertLedgerBalances(entries, EXAMPLE_SPLIT.totalCents),
    ).toBeUndefined()
  })

  it('accepts three zero entries against a zero payment', () => {
    const entries = toLedgerEntries(ZERO_SPLIT)
    expect(assertLedgerBalances(entries, 0)).toBeUndefined()
  })

  it('accepts one of each type in any order', () => {
    // toLedgerEntries fixes the order. The balance check only requires one of
    // each type, non-negative integers, and an exact sum.
    const entries: LedgerEntryDraft[] = [
      { type: 'platform_fee', amountCents: 90 },
      { type: 'cogs', amountCents: 7000 },
      { type: 'provider_margin', amountCents: 5000 },
    ]
    expect(assertLedgerBalances(entries, 12090)).toBeUndefined()
  })

  it.each<LedgerFailureCase>([
    {
      label: 'payment is one cent above the entries',
      entries: [
        { type: 'cogs', amountCents: 40 },
        { type: 'provider_margin', amountCents: 40 },
        { type: 'platform_fee', amountCents: 20 },
      ],
      amountPaidCents: 101,
    },
    {
      label: 'payment is one cent below the entries',
      entries: [
        { type: 'cogs', amountCents: 40 },
        { type: 'provider_margin', amountCents: 40 },
        { type: 'platform_fee', amountCents: 20 },
      ],
      amountPaidCents: 99,
    },
  ])('$label', ({ entries, amountPaidCents }) => {
    expectImbalance(entries, amountPaidCents)
  })

  it.each<LedgerFailureCase>([
    {
      label: 'missing platform fee',
      entries: [
        { type: 'cogs', amountCents: 60 },
        { type: 'provider_margin', amountCents: 40 },
      ],
      amountPaidCents: 100,
    },
    {
      label: 'missing cogs',
      entries: [
        { type: 'provider_margin', amountCents: 70 },
        { type: 'platform_fee', amountCents: 30 },
      ],
      amountPaidCents: 100,
    },
    {
      label: 'missing provider margin',
      entries: [
        { type: 'cogs', amountCents: 80 },
        { type: 'platform_fee', amountCents: 20 },
      ],
      amountPaidCents: 100,
    },
  ])('$label', ({ entries, amountPaidCents }) => {
    expectImbalance(entries, amountPaidCents)
  })

  it('rejects a duplicate type even when three amounts sum to the payment', () => {
    const entries: LedgerEntryDraft[] = [
      { type: 'cogs', amountCents: 30 },
      { type: 'cogs', amountCents: 30 },
      { type: 'platform_fee', amountCents: 40 },
    ]
    expectImbalance(entries, 100)
  })

  it('rejects an extra entry even when the amounts sum to the payment', () => {
    const entries: LedgerEntryDraft[] = [
      { type: 'cogs', amountCents: 70 },
      { type: 'provider_margin', amountCents: 20 },
      { type: 'platform_fee', amountCents: 10 },
      { type: 'cogs', amountCents: 0 },
    ]
    expectImbalance(entries, 100)
  })

  it('rejects a negative amount even when the amounts sum to the payment', () => {
    const entries: LedgerEntryDraft[] = [
      { type: 'cogs', amountCents: -1 },
      { type: 'provider_margin', amountCents: 50 },
      { type: 'platform_fee', amountCents: 51 },
    ]
    expectImbalance(entries, 100)
  })

  it('rejects a non-integer amount even when the amounts sum to the payment', () => {
    const entries: LedgerEntryDraft[] = [
      { type: 'cogs', amountCents: 10.5 },
      { type: 'provider_margin', amountCents: 20 },
      { type: 'platform_fee', amountCents: 69.5 },
    ]
    expectImbalance(entries, 100)
  })

  it('rejects NaN and infinite amounts', () => {
    const cases: LedgerFailureCase[] = [
      {
        label: 'NaN',
        entries: [
          { type: 'cogs', amountCents: Number.NaN },
          { type: 'provider_margin', amountCents: 0 },
          { type: 'platform_fee', amountCents: 0 },
        ],
        amountPaidCents: 0,
      },
      {
        label: 'Infinity',
        entries: [
          { type: 'cogs', amountCents: Number.POSITIVE_INFINITY },
          { type: 'provider_margin', amountCents: 0 },
          { type: 'platform_fee', amountCents: 0 },
        ],
        amountPaidCents: Number.POSITIVE_INFINITY,
      },
    ]
    cases.forEach((entryCase) => {
      expectImbalance(entryCase.entries, entryCase.amountPaidCents)
    })
  })
})
