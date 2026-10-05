import { SplitValidationError } from './errors'

// Margin is the provider's gross share of the patient price, in basis points:
// (price - cost) / price. Both conversions round half up toward +infinity and
// use BigInt division so they stay exact for any integer input.

const BPS = 10_000n

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/** floor(numerator / denominator + 1/2) for a positive denominator. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): number {
  const doubled = numerator * 2n + denominator
  const twice = denominator * 2n
  const quotient = doubled / twice
  // BigInt division truncates toward zero; step down for negative non-exact results.
  const floored =
    doubled < 0n && quotient * twice !== doubled ? quotient - 1n : quotient
  return Number(floored)
}

/**
 * (price - cost) * 10000 / price, rounded half up. 0 when the price is 0.
 * Negative when the price is below cost.
 */
export function marginBpsFromPrice(
  unitCogsCents: number,
  unitPriceCents: number,
): number {
  if (
    !isNonNegativeInteger(unitCogsCents) ||
    !isNonNegativeInteger(unitPriceCents)
  ) {
    throw new SplitValidationError('INVALID_AMOUNT')
  }
  if (unitPriceCents === 0) return 0
  const price = BigInt(unitPriceCents)
  return divideRoundHalfUp((price - BigInt(unitCogsCents)) * BPS, price)
}

/**
 * cost * 10000 / (10000 - margin), rounded half up. Requires an integer margin
 * in [0, 10000). The result can be below minUnitPriceCents(cost); callers
 * validate it with the minimum rule.
 */
export function priceFromMarginBps(
  unitCogsCents: number,
  marginBps: number,
): number {
  if (
    !isNonNegativeInteger(unitCogsCents) ||
    !Number.isInteger(marginBps) ||
    marginBps < 0 ||
    marginBps >= 10_000
  ) {
    throw new SplitValidationError('INVALID_AMOUNT')
  }
  return divideRoundHalfUp(BigInt(unitCogsCents) * BPS, BPS - BigInt(marginBps))
}
