import { describe, expect, it } from 'vitest'
import { SplitValidationError } from './errors'
import { computePlatformFee } from './split'

// Implementer-added: the contract only requires INVALID_AMOUNT from computePlatformFee,
// but returning an inexact fee silently is worse than refusing. Revision 7 moved
// the boundary: the fee intermediate is now subtotal * 75 + 9999 (rounding up).
describe('computePlatformFee overflow guard', () => {
  it('is exact up to the largest subtotal whose subtotal * 75 + 9999 is safe', () => {
    // ceil(120_095_990_063_079 * 75 / 10000) = 900_719_925_473.0925 -> ...474
    expect(computePlatformFee(120_095_990_063_079)).toBe(900_719_925_474)
  })

  it('throws UNSAFE_AMOUNT one cent past that boundary', () => {
    const thrown = (() => {
      try {
        computePlatformFee(120_095_990_063_080)
      } catch (caught: unknown) {
        return caught
      }
      return undefined
    })()
    expect(thrown).toBeInstanceOf(SplitValidationError)
    expect(thrown).toMatchObject({
      code: 'UNSAFE_AMOUNT',
      lineIndex: undefined,
    })
  })
})
