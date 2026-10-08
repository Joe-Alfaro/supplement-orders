import { describe, expect, it } from 'vitest'
import { partialPaymentQuoteDto } from '../api/quote'
import { conservedSplitFees, planPartialPayment } from './partial'
import { computePlatformFee } from './split'

// Revision 18.4 (L5) and 18.1: a split conserves the order's stored fee, and a
// quote for an order that already has a live back-order is honest about not
// being payable while short.

describe('conservedSplitFees', () => {
  it("keeps the auditor's R5 fee: 17 cents unsplit is 17 across the halves", () => {
    expect(computePlatformFee(2200)).toBe(17)
    expect(computePlatformFee(1100) * 2).toBe(18)
    expect(conservedSplitFees(17, 1100)).toEqual({
      payFeeCents: 9,
      backorderFeeCents: 8,
    })
  })

  it('never leaves a negative remainder, and always sums to the order fee', () => {
    const subtotals = Array.from({ length: 400 }, (_, i) => i * 37 + 1)
    subtotals.forEach((total) => {
      const fee = computePlatformFee(total)
      ;[0, 1, Math.floor(total / 3), total - 1, total].forEach((pay) => {
        const { payFeeCents, backorderFeeCents } = conservedSplitFees(fee, pay)
        expect(payFeeCents + backorderFeeCents).toBe(fee)
        expect(backorderFeeCents).toBeGreaterThanOrEqual(0)
        expect(payFeeCents).toBeLessThanOrEqual(computePlatformFee(pay))
      })
    })
  })

  it('caps the pay fee at a smaller stored fee further down a chain', () => {
    expect(conservedSplitFees(8, 1100)).toEqual({
      payFeeCents: 8,
      backorderFeeCents: 0,
    })
  })
})

describe('partialPaymentQuoteDto (revision 18.1)', () => {
  const lines = [
    { productId: 1, quantity: 2, unitPriceCents: 1100, unitCogsCents: 850 },
  ]

  it('is unpayable with awaiting_restock when short with a live back-order', () => {
    const plan = planPartialPayment(lines, { 1: 1 })
    expect(
      partialPaymentQuoteDto(plan, 'provider', {
        orderFeeCents: 17,
        hasLiveBackorder: true,
      }),
    ).toEqual({
      pay: { subtotalCents: 1100, totalCents: 1100, platformFeeCents: 9 },
      backorder: { subtotalCents: 1100, totalCents: 1100, platformFeeCents: 8 },
      payable: false,
      hasShortfall: true,
      reason: 'awaiting_restock',
    })
  })

  it('stays payable without a shortfall, and without a live back-order', () => {
    const inStock = planPartialPayment(lines, { 1: 5 })
    expect(
      partialPaymentQuoteDto(inStock, 'patient', { hasLiveBackorder: true }),
    ).toEqual({
      pay: { subtotalCents: 2200, totalCents: 2200 },
      backorder: { subtotalCents: 0, totalCents: 0 },
      payable: true,
      hasShortfall: false,
    })
    const short = planPartialPayment(lines, { 1: 1 })
    expect(partialPaymentQuoteDto(short, 'patient').payable).toBe(true)
  })
})
