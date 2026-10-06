import { SplitValidationError } from './errors'
import { minUnitPriceCents, PLATFORM_FEE_BPS } from './split'

// Revision 5: markup is the provider's net profit on wholesale cost after the
// processing fee at its exact rate: (price - cost - 0.0075 * price) / cost, in
// basis points, uncapped. BigInt keeps both conversions exact for any safe input.

const BPS = 10_000n
/** What the provider keeps per unit of price, in bps: 10000 - 75. */
const NET_BPS = BPS - BigInt(PLATFORM_FEE_BPS)

/**
 * Same input rules as computeSplit: a negative, fractional or non-finite value
 * is INVALID_AMOUNT; an integer at or above 2 ** 53 is UNSAFE_AMOUNT.
 */
function assertAmounts(...values: number[]) {
  if (!values.every((v) => Number.isInteger(v) && v >= 0)) {
    throw new SplitValidationError('INVALID_AMOUNT')
  }
  if (!values.every(Number.isSafeInteger)) {
    throw new SplitValidationError('UNSAFE_AMOUNT')
  }
}

/** floor(numerator / denominator + 1/2) for a positive denominator. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const doubled = numerator * 2n + denominator
  const twice = denominator * 2n
  const quotient = doubled / twice
  // BigInt division truncates toward zero; step down for negative non-exact results.
  return doubled < 0n && quotient * twice !== doubled ? quotient - 1n : quotient
}

function toSafeNumber(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new SplitValidationError('UNSAFE_AMOUNT')
  }
  return result
}

/**
 * (9925 * price - 10000 * cost) / cost, rounded half up toward +infinity.
 * Null when the cost is 0, where markup is undefined. Negative below cost plus fee.
 */
export function markupBpsFromPrice(
  unitCogsCents: number,
  unitPriceCents: number,
): number | null {
  assertAmounts(unitCogsCents, unitPriceCents)
  if (unitCogsCents === 0) return null
  const cost = BigInt(unitCogsCents)
  return toSafeNumber(
    divideRoundHalfUp(NET_BPS * BigInt(unitPriceCents) - BPS * cost, cost),
  )
}

/**
 * cost * (10000 + markup) / 9925, rounded half up, and never below
 * minUnitPriceCents(cost), so 0 bps maps exactly to the minimum price.
 * Markup is an integer >= 0 with no upper bound. A zero cost prices at 0.
 */
export function priceFromMarkupBps(
  unitCogsCents: number,
  markupBps: number,
): number {
  assertAmounts(unitCogsCents, markupBps)
  if (unitCogsCents === 0) return 0
  const price = toSafeNumber(
    divideRoundHalfUp(
      BigInt(unitCogsCents) * (BPS + BigInt(markupBps)),
      NET_BPS,
    ),
  )
  return Math.max(price, minUnitPriceCents(unitCogsCents))
}
