import { describe, expect, it } from 'vitest'
import { payableQuantity, quoteAvailable, shortQuantity } from './stock'

describe('payableQuantity and shortQuantity', () => {
  it('caps at available stock and reports the shortfall', () => {
    expect(payableQuantity(5, 3)).toBe(3)
    expect(shortQuantity(5, 3)).toBe(2)
    expect(payableQuantity(5, 0)).toBe(0)
    expect(shortQuantity(5, 0)).toBe(5)
  })

  it('is fully payable when stock covers the quantity or is unknown', () => {
    expect(payableQuantity(5, 5)).toBe(5)
    expect(payableQuantity(5, 99)).toBe(5)
    expect(shortQuantity(5, undefined)).toBe(0)
  })
})

describe('quoteAvailable', () => {
  it('splits the patient total into the in-stock part and the rest, in cents', () => {
    const quote = quoteAvailable([
      { quantity: 3, unitPriceCents: 4000, availableQuantity: 3 },
      { quantity: 5, unitPriceCents: 1999, availableQuantity: 2 },
      { quantity: 2, unitPriceCents: 500, availableQuantity: 0 },
    ])
    expect(quote).toEqual({
      payCents: 12000 + 3998,
      backorderCents: 3 * 1999 + 1000,
      hasShortfall: true,
      nothingPayable: false,
    })
  })

  it('has no shortfall when everything is in stock', () => {
    const quote = quoteAvailable([
      { quantity: 1, unitPriceCents: 100, availableQuantity: 1 },
    ])
    expect(quote.hasShortfall).toBe(false)
    expect(quote.backorderCents).toBe(0)
  })

  it('has nothing payable when every line is out of stock', () => {
    const quote = quoteAvailable([
      { quantity: 1, unitPriceCents: 100, availableQuantity: 0 },
      { quantity: 4, unitPriceCents: 100, availableQuantity: 0 },
    ])
    expect(quote.nothingPayable).toBe(true)
    expect(quote.payCents).toBe(0)
  })
})
