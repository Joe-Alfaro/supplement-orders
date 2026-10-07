import { describe, expect, it } from 'vitest'
import { partialPaymentQuote, planPartialPayment } from './partial'
import { computePlatformFee, computeSplit, minUnitPriceCents } from './split'

const a = {
  productId: 1,
  quantity: 3,
  unitPriceCents: 2000,
  unitCogsCents: 900,
}
const b = {
  productId: 2,
  quantity: 5,
  unitPriceCents: 1500,
  unitCogsCents: 700,
}

describe('planPartialPayment', () => {
  it('pays everything when every line is in stock', () => {
    const plan = planPartialPayment(
      [a, b],
      new Map([
        [1, 3],
        [2, 50],
      ]),
    )
    expect(plan).toEqual({
      payLines: [a, b],
      backorderLines: [],
      payable: true,
      hasShortfall: false,
    })
  })

  it('splits partial stock per line, keeping prices and cogs snapshots', () => {
    const plan = planPartialPayment([a, b], { 1: 1, 2: 0 })
    expect(plan.payLines).toEqual([{ ...a, quantity: 1 }])
    expect(plan.backorderLines).toEqual([
      { ...a, quantity: 2 },
      { ...b, quantity: 5 },
    ])
    expect(plan.payable).toBe(true)
    expect(plan.hasShortfall).toBe(true)
  })

  it('has nothing payable when no line has stock, and treats missing products as 0', () => {
    const plan = planPartialPayment([a, b], new Map([[1, 0]]))
    expect(plan.payLines).toEqual([])
    expect(plan.backorderLines).toEqual([a, b])
    expect(plan.payable).toBe(false)
  })

  it('treats negative availability as none and keeps extra line fields', () => {
    const line = { ...a, lineId: 7 }
    const plan = planPartialPayment([line], { 1: -4 })
    expect(plan.backorderLines).toEqual([line])
  })
})

describe('partialPaymentQuote', () => {
  it('prices each half as its own order', () => {
    const plan = planPartialPayment([a, b], { 1: 1, 2: 2 })
    const quote = partialPaymentQuote(plan)
    expect(quote.pay).toEqual({
      subtotalCents: 2000 + 3000,
      platformFeeCents: computePlatformFee(5000),
      totalCents: 5000,
    })
    expect(quote.backorder.totalCents).toBe(4000 + 4500)
  })

  it('returns zeros for an empty half', () => {
    const quote = partialPaymentQuote(planPartialPayment([a], { 1: 3 }))
    expect(quote.backorder).toEqual({
      subtotalCents: 0,
      platformFeeCents: 0,
      totalCents: 0,
    })
  })

  it('charges at most 1 cent more in fees than the unsplit order, and keeps margins non-negative at minimum prices', () => {
    const costs = [1, 66, 133, 581, 850, 1275, 2199]
    costs.forEach((cogs) => {
      const price = minUnitPriceCents(cogs)
      const line = {
        productId: 1,
        quantity: 7,
        unitPriceCents: price,
        unitCogsCents: cogs,
      }
      const other = {
        productId: 2,
        quantity: 3,
        unitPriceCents: price + 13,
        unitCogsCents: cogs,
      }
      ;[0, 1, 3, 6].forEach((available) => {
        const plan = planPartialPayment([line, other], { 1: available, 2: 1 })
        const quote = partialPaymentQuote(plan)
        const whole = computeSplit([line, other])
        const fees =
          quote.pay.platformFeeCents + quote.backorder.platformFeeCents
        expect(fees - whole.platformFeeCents).toBeGreaterThanOrEqual(0)
        expect(fees - whole.platformFeeCents).toBeLessThanOrEqual(1)
        expect(quote.pay.totalCents + quote.backorder.totalCents).toBe(
          whole.totalCents,
        )
        expect(
          computeSplit(plan.payLines).providerMarginCents,
        ).toBeGreaterThanOrEqual(0)
        expect(
          computeSplit(plan.backorderLines).providerMarginCents,
        ).toBeGreaterThanOrEqual(0)
      })
    })
  })
})
