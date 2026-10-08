import { describe, expect, it } from 'vitest'
import {
  paymentJournal,
  assertJournalBalances,
  splitFromPostings,
} from './journal'
import { computeSplit, minUnitPriceCents } from './split'

// Revision 16 naming choices: journal.ts exports the three functions. Draft
// postings carry { accountId, accountCode, amountCents }; codes let the pure
// inverse identify buckets without a database. Account IDs are supplied here.
const accounts = {
  cashAccountId: 11,
  productSalesAccountId: 12,
  platformFeeAccountId: 13,
  providerAccountId: 14,
  providerAccountCode: '2100-7',
}
interface DraftPosting {
  accountId: number
  accountCode: string
  amountCents: number
}
function posting(amountCents: number, accountCode = '1000') {
  return { accountId: 11, accountCode, amountCents }
}

describe('revision 16 payment journals', () => {
  it('debits cash and credits wholesale, payable and fee with exact account identities', () => {
    const split = computeSplit([
      { quantity: 1, unitPriceCents: 12000, unitCogsCents: 7000 },
    ])
    expect(paymentJournal(split, accounts)).toEqual(
      expect.arrayContaining([
        { accountId: 11, accountCode: '1000', amountCents: 12000 },
        { accountId: 12, accountCode: '4000', amountCents: -7000 },
        { accountId: 13, accountCode: '4100', amountCents: -90 },
        { accountId: 14, accountCode: '2100-7', amountCents: -4910 },
      ]),
    )
    expect(paymentJournal(split, accounts)).toHaveLength(4)
  })

  it('balances and round-trips 2000 deterministic seeded multi-line splits', () => {
    let seed = 16007
    function random(max: number) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    Array.from({ length: 2000 }).forEach(() => {
      const lines = Array.from({ length: 1 + random(8) }, () => {
        const unitCogsCents = 1 + random(100000)
        return {
          quantity: 1 + random(20),
          unitCogsCents,
          unitPriceCents: minUnitPriceCents(unitCogsCents) + random(5000),
        }
      })
      const split = computeSplit(lines)
      const before = structuredClone(split)
      const entries: readonly DraftPosting[] = paymentJournal(split, accounts)
      expect(() => assertJournalBalances(entries)).not.toThrow()
      expect(
        entries.every(
          (entry) =>
            Number.isSafeInteger(entry.amountCents) && entry.amountCents !== 0,
        ),
      ).toBe(true)
      expect(
        entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n),
      ).toBe(0n)
      expect(splitFromPostings([...entries].reverse())).toEqual({
        totalCents: split.totalCents,
        cogsCents: split.cogsCents,
        providerMarginCents: split.providerMarginCents,
        platformFeeCents: split.platformFeeCents,
      })
      expect(split).toEqual(before)
    })
  })

  it('omits zero margin and reconstructs the missing bucket as zero', () => {
    const entries: readonly DraftPosting[] = paymentJournal(
      computeSplit([{ quantity: 1, unitCogsCents: 66, unitPriceCents: 67 }]),
      accounts,
    )
    expect(entries).toHaveLength(3)
    expect(entries.some((entry) => entry.accountCode === '2100-7')).toBe(false)
    expect(splitFromPostings(entries)).toEqual({
      totalCents: 67,
      cogsCents: 66,
      providerMarginCents: 0,
      platformFeeCents: 1,
    })
  })

  it('omits a stored zero fee without recomputing historical fee rounding', () => {
    const entries: readonly DraftPosting[] = paymentJournal(
      {
        subtotalCents: 66,
        totalCents: 66,
        cogsCents: 60,
        providerMarginCents: 6,
        platformFeeCents: 0,
      },
      accounts,
    )
    expect(entries).toHaveLength(3)
    expect(entries.some((entry) => entry.accountCode === '4100')).toBe(false)
    expect(splitFromPostings(entries)).toEqual({
      totalCents: 66,
      cogsCents: 60,
      providerMarginCents: 6,
      platformFeeCents: 0,
    })
    expect(() => assertJournalBalances(entries)).not.toThrow()
  })

  it('omits zero wholesale cost', () => {
    const entries: readonly DraftPosting[] = paymentJournal(
      computeSplit([{ quantity: 1, unitCogsCents: 0, unitPriceCents: 100 }]),
      accounts,
    )
    expect(entries).toHaveLength(3)
    expect(splitFromPostings(entries)).toEqual({
      totalCents: 100,
      cogsCents: 0,
      providerMarginCents: 99,
      platformFeeCents: 1,
    })
  })

  it.each([
    [],
    [posting(1)],
    [posting(0), posting(0, '4000')],
    [posting(10), posting(-9, '4000')],
    [posting(1.5), posting(-1.5, '4000')],
    [posting(NaN), posting(-1, '4000')],
    [posting(Infinity), posting(-Infinity, '4000')],
    [
      posting(Number.MAX_SAFE_INTEGER + 1),
      posting(-(Number.MAX_SAFE_INTEGER + 1), '4000'),
    ],
    // A Number-only sum falsely becomes zero after rounding MAX_SAFE + 2.
    [
      posting(Number.MAX_SAFE_INTEGER),
      posting(2),
      posting(-Number.MAX_SAFE_INTEGER),
      posting(-1),
    ],
  ])('rejects malformed or unbalanced postings %#', (...entries) => {
    expect(() => assertJournalBalances(entries)).toThrow()
  })

  it('accepts two nonzero opposite safe integers, including the safe boundary', () => {
    expect(() =>
      assertJournalBalances([
        posting(Number.MAX_SAFE_INTEGER),
        posting(-Number.MAX_SAFE_INTEGER, '4000'),
      ]),
    ).not.toThrow()
  })
})
