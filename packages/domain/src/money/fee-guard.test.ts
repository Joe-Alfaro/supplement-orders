import { describe, expect, it } from 'vitest'
import { SplitValidationError } from './errors'
import { computePlatformFee } from './split'

// Implementer-added: the contract only requires INVALID_AMOUNT from computePlatformFee,
// but returning an inexact fee silently is worse than refusing.
describe('computePlatformFee overflow guard', () => {
  it('throws UNSAFE_AMOUNT once subtotal * 75 + 5000 is no longer a safe integer', () => {
    const thrown = (() => {
      try {
        computePlatformFee(120_095_990_063_147)
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
