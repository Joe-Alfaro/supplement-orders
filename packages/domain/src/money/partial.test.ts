import { describe, expect, it } from 'vitest'
import { planPartialPayment, partialPaymentQuote } from './partial'
import { computeSplit, minUnitPriceCents } from './split'

// Revision 14 leaves the availability container and quote shape open. Use a
// numeric-keyed record and { pay, backorder } totals; empty sides total zero.
const lines = [
  { productId: 11, quantity: 3, unitPriceCents: 101, unitCogsCents: 100 },
  { productId: 22, quantity: 2, unitPriceCents: 201, unitCogsCents: 199 },
]
const zero = { subtotalCents: 0, platformFeeCents: 0, totalCents: 0 }

describe('revision 14 partial payment domain', () => {
  it.each([3, 10])(
    'keeps all lines when stock is equal or greater (%s)',
    (stock) => {
      expect(planPartialPayment(lines, { 11: stock, 22: stock })).toEqual({
        payLines: lines,
        backorderLines: [],
        payable: true,
        hasShortfall: false,
      })
    },
  )

  it('partitions multiple lines, omits zero quantities and preserves snapshots without mutation', () => {
    const before = structuredClone(lines)
    expect(planPartialPayment(lines, { 11: 1, 22: 0 })).toEqual({
      payLines: [{ ...lines[0], quantity: 1 }],
      backorderLines: [{ ...lines[0], quantity: 2 }, lines[1]],
      payable: true,
      hasShortfall: true,
    })
    expect(lines).toEqual(before)
  })

  it('has nothing payable when every product has zero stock', () => {
    expect(planPartialPayment(lines, { 11: 0, 22: 0 })).toEqual({
      payLines: [],
      backorderLines: lines,
      payable: false,
      hasShortfall: true,
    })
  })

  it('quotes both portions in integer cents with independently rounded fees', () => {
    expect(partialPaymentQuote(lines, { 11: 1, 22: 0 })).toEqual({
      pay: { subtotalCents: 101, platformFeeCents: 1, totalCents: 101 },
      backorder: { subtotalCents: 604, platformFeeCents: 5, totalCents: 604 },
    })
  })

  it('quotes an empty side as zero rather than computing an empty order', () => {
    expect(partialPaymentQuote(lines, { 11: 0, 22: 0 }).pay).toEqual(zero)
    expect(partialPaymentQuote(lines, { 11: 99, 22: 99 }).backorder).toEqual(
      zero,
    )
  })

  it('preserves the unit minimum and bounds the extra split fee by one cent', () => {
    // ceil(a) + ceil(b) - ceil(a+b) is either 0 or 1. Sweep fee residues,
    // including an explicit witness where splitting costs the extra cent.
    const extras = Array.from({ length: 400 }, (_, index) => {
      const cost = index + 1
      const input = [
        {
          productId: 1,
          quantity: 7,
          unitCogsCents: cost,
          unitPriceCents: minUnitPriceCents(cost),
        },
      ]
      const plan = planPartialPayment(input, { 1: (index % 6) + 1 })
      const paid = computeSplit(plan.payLines)
      const backorder = computeSplit(plan.backorderLines)
      const original = computeSplit(input)
      ;[...plan.payLines, ...plan.backorderLines].forEach((line) => {
        expect(line.unitPriceCents).toBe(minUnitPriceCents(line.unitCogsCents))
      })
      expect(paid.providerMarginCents).toBeGreaterThanOrEqual(0)
      expect(backorder.providerMarginCents).toBeGreaterThanOrEqual(0)
      expect(paid.totalCents + backorder.totalCents).toBe(original.totalCents)
      const extra =
        paid.platformFeeCents +
        backorder.platformFeeCents -
        original.platformFeeCents
      expect([0, 1]).toContain(extra)
      return extra
    })
    expect(new Set(extras)).toEqual(new Set([0, 1]))
  })
})
