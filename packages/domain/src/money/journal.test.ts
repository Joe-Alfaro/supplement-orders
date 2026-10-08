import { describe, expect, it } from 'vitest'
import { LedgerImbalanceError } from './errors'
import {
  assertJournalBalances,
  paymentJournal,
  providerPayableAccountCode,
  splitFromPostings,
} from './journal'
import { computeSplit, minUnitPriceCents, type SplitLine } from './split'

// Revision 2 example: the patient pays $120.00; the $0.90 fee comes out of the
// markup, so the provider keeps $49.10.
const EXAMPLE_SPLIT = computeSplit([
  { quantity: 1, unitPriceCents: 12000, unitCogsCents: 7000 },
])

// One unit at the minimum for cost 66: markup 1 equals the fee, so margin is 0.
const ZERO_MARGIN_SPLIT = computeSplit([
  { quantity: 1, unitPriceCents: 67, unitCogsCents: 66 },
])

/** Numerical Recipes LCG, so every run checks the same splits. */
function lcg(seed: number) {
  const state = { value: seed >>> 0 }
  return function next(modulus: number) {
    state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0
    return state.value % modulus
  }
}

function randomLines(next: (modulus: number) => number): SplitLine[] {
  // One order in five is a single unit at its minimum price: margin is often 0.
  if (next(5) === 0) {
    const unitCogsCents = next(50_000)
    return [
      {
        quantity: 1,
        unitPriceCents: minUnitPriceCents(unitCogsCents),
        unitCogsCents,
      },
    ]
  }
  return Array.from({ length: 1 + next(5) }, () => {
    const unitCogsCents = next(4) === 0 ? 0 : next(50_000)
    const minimum = minUnitPriceCents(unitCogsCents)
    // A quarter of lines sit exactly at the minimum (margin can be 0).
    const unitPriceCents =
      next(4) === 0 ? minimum : minimum + next(1000 + unitCogsCents * 3)
    return { quantity: 1 + next(1000), unitPriceCents, unitCogsCents }
  })
}

const SPLITS = (() => {
  const next = lcg(20261008)
  return Array.from({ length: 5000 }, () => computeSplit(randomLines(next)))
})().filter((split) => split.totalCents > 0)

describe('paymentJournal', () => {
  it('debits cash with the total and credits cogs, margin and fee', () => {
    expect(
      paymentJournal(EXAMPLE_SPLIT, {
        cashAccountId: 1,
        productSalesAccountId: 2,
        platformFeeAccountId: 3,
        providerAccountId: 4,
      }),
    ).toEqual([
      { accountId: 1, accountCode: '1000', amountCents: 12000 },
      { accountId: 2, accountCode: '4000', amountCents: -7000 },
      { accountId: 4, accountCode: '2100', amountCents: -4910 },
      { accountId: 3, accountCode: '4100', amountCents: -90 },
    ])
  })

  it('omits zero postings, such as the margin at minimum prices', () => {
    expect(paymentJournal(ZERO_MARGIN_SPLIT)).toEqual([
      { accountCode: '1000', amountCents: 67 },
      { accountCode: '4000', amountCents: -66 },
      { accountCode: '4100', amountCents: -1 },
    ])
  })

  it('has no postings for a zero-total split, which cannot balance', () => {
    const zero = computeSplit([
      { quantity: 1, unitPriceCents: 0, unitCogsCents: 0 },
    ])
    expect(paymentJournal(zero)).toEqual([])
    expect(() => assertJournalBalances(paymentJournal(zero))).toThrow(
      LedgerImbalanceError,
    )
  })

  it(`always balances and round-trips the split (${SPLITS.length} seeded splits)`, () => {
    expect(SPLITS.length).toBeGreaterThan(4000)
    expect(SPLITS.some((split) => split.providerMarginCents === 0)).toBe(true)
    expect(SPLITS.some((split) => split.cogsCents === 0)).toBe(true)
    SPLITS.forEach((split) => {
      const postings = paymentJournal(split, {
        providerAccountId: 9,
        providerAccountCode: '2100-7',
      })
      expect(() => assertJournalBalances(postings)).not.toThrow()
      expect(postings[0]).toEqual({
        accountCode: '1000',
        amountCents: split.totalCents,
      })
      expect(postings.slice(1).every((p) => p.amountCents < 0)).toBe(true)
      expect(splitFromPostings(postings)).toEqual({
        cogsCents: split.cogsCents,
        providerMarginCents: split.providerMarginCents,
        platformFeeCents: split.platformFeeCents,
        totalCents: split.totalCents,
      })
    })
  })
})

describe('assertJournalBalances', () => {
  it('accepts two or more non-zero postings summing to 0', () => {
    expect(() =>
      assertJournalBalances([{ amountCents: 5 }, { amountCents: -5 }]),
    ).not.toThrow()
  })

  it.each([
    ['no postings', []],
    ['a single posting', [{ amountCents: 0 }]],
    ['an unbalanced journal', [{ amountCents: 5 }, { amountCents: -4 }]],
    [
      'a zero posting',
      [{ amountCents: 5 }, { amountCents: -5 }, { amountCents: 0 }],
    ],
    ['a fractional amount', [{ amountCents: 0.5 }, { amountCents: -0.5 }]],
    [
      'an unsafe amount',
      [
        { amountCents: Number.MAX_SAFE_INTEGER + 1 },
        { amountCents: -(Number.MAX_SAFE_INTEGER + 1) },
      ],
    ],
    [
      'sides that only balance after rounding',
      [
        { amountCents: Number.MAX_SAFE_INTEGER },
        { amountCents: 2 },
        { amountCents: -Number.MAX_SAFE_INTEGER },
        { amountCents: -1 },
        { amountCents: -1 },
      ],
    ],
  ])('rejects %s', (_label, postings) => {
    const caught = (() => {
      try {
        assertJournalBalances(postings)
      } catch (error: unknown) {
        return error
      }
      return undefined
    })()
    expect(caught).toBeInstanceOf(LedgerImbalanceError)
    expect(caught).toMatchObject({ expectedCents: 0 })
  })
})

describe('splitFromPostings', () => {
  it('reads omitted credits as 0', () => {
    expect(
      splitFromPostings([
        { accountCode: '1000', amountCents: 67 },
        { accountCode: '4000', amountCents: -66 },
        { accountCode: '4100', amountCents: -1 },
      ]),
    ).toEqual({
      cogsCents: 66,
      providerMarginCents: 0,
      platformFeeCents: 1,
      totalCents: 67,
    })
  })
})

describe('paymentJournal account codes', () => {
  it('uses the provider payable code it is given', () => {
    expect(
      paymentJournal(EXAMPLE_SPLIT, { providerAccountCode: '2100-3' })[2],
    ).toEqual({ accountCode: '2100-3', amountCents: -4910 })
  })
})

describe('providerPayableAccountCode', () => {
  it('is 2100-<providerId>', () => {
    expect(providerPayableAccountCode(42)).toBe('2100-42')
  })
})
