import { SplitValidationError } from './errors'

export const PLATFORM_FEE_BPS = 75

const BPS_DENOMINATOR = 10_000
// Adding denominator - 1 before flooring is a ceiling in integer arithmetic.
const CEILING_OFFSET = BPS_DENOMINATOR - 1

export interface SplitLine {
  quantity: number
  unitPriceCents: number
  unitCogsCents: number
}

export interface OrderSplit {
  subtotalCents: number
  platformFeeCents: number
  totalCents: number
  cogsCents: number
  providerMarginCents: number
}

interface RunningTotals {
  subtotalCents: number
  cogsCents: number
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/** Shared by the fee and computeSplit's per-line overflow guard, so both use one threshold. */
function feeNumerator(subtotalCents: number): number {
  return subtotalCents * PLATFORM_FEE_BPS + CEILING_OFFSET
}

/**
 * 75 bps of the subtotal, rounded UP to the next whole cent (revision 7), so
 * cost + displayed fee equals the minimum price, which also rounds the fee up.
 */
export function computePlatformFee(subtotalCents: number): number {
  if (!isNonNegativeInteger(subtotalCents)) {
    throw new SplitValidationError('INVALID_AMOUNT')
  }
  const numerator = feeNumerator(subtotalCents)
  // Past this point the numerator is no longer exact, so the fee could be off by a cent.
  if (!Number.isSafeInteger(numerator)) {
    throw new SplitValidationError('UNSAFE_AMOUNT')
  }
  return Math.floor(numerator / BPS_DENOMINATOR)
}

// Minimum-price algebra. With p = c + k, the markup k must cover the per-unit fee
// rounded up: k >= ceil(75p / 10000). For integer k that holds exactly when
// 9925k >= 75c, i.e. when 9925p >= 10000c. Hence min = c + ceil(75c / 9925).
const MIN_PRICE_MARKUP_DENOMINATOR = BPS_DENOMINATOR - PLATFORM_FEE_BPS

/**
 * The smallest unit price whose markup covers 75 bps of that price rounded up
 * to the cent. Any order with every line at or above its minimum has a
 * non-negative provider margin, because the order-level fee (rounded up on
 * the subtotal) never exceeds the sum of the per-unit fees rounded up.
 */
export function minUnitPriceCents(unitCogsCents: number): number {
  if (!isNonNegativeInteger(unitCogsCents)) {
    throw new SplitValidationError('INVALID_AMOUNT')
  }
  const numerator =
    unitCogsCents * PLATFORM_FEE_BPS + (MIN_PRICE_MARKUP_DENOMINATOR - 1)
  if (!Number.isSafeInteger(numerator)) {
    throw new SplitValidationError('UNSAFE_AMOUNT')
  }
  return unitCogsCents + Math.floor(numerator / MIN_PRICE_MARKUP_DENOMINATOR)
}

/** Exact for any integers: compared as BigInt so huge inputs cannot misround. */
function isAtLeastMinimum(unitPriceCents: number, unitCogsCents: number) {
  return (
    BigInt(MIN_PRICE_MARKUP_DENOMINATOR) * BigInt(unitPriceCents) >=
    BigInt(BPS_DENOMINATOR) * BigInt(unitCogsCents)
  )
}

function addLine(
  totals: RunningTotals,
  line: SplitLine,
  lineIndex: number,
): RunningTotals {
  const { quantity, unitPriceCents, unitCogsCents } = line
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new SplitValidationError('INVALID_QUANTITY', lineIndex)
  }
  if (
    !isNonNegativeInteger(unitPriceCents) ||
    !isNonNegativeInteger(unitCogsCents)
  ) {
    throw new SplitValidationError('INVALID_AMOUNT', lineIndex)
  }
  if (!isAtLeastMinimum(unitPriceCents, unitCogsCents)) {
    throw new SplitValidationError('PRICE_BELOW_MINIMUM', lineIndex)
  }

  const extensionCents = quantity * unitPriceCents
  const subtotalCents = totals.subtotalCents + extensionCents
  // COGS never exceeds price, so cogs <= subtotal and total < fee numerator.
  // A safe fee numerator therefore bounds every field. Checking it here, per
  // line, blames the line whose addition first made the order unsafe.
  const isSafe =
    [quantity, unitPriceCents, extensionCents].every(Number.isSafeInteger) &&
    Number.isSafeInteger(feeNumerator(subtotalCents))
  if (!isSafe) {
    throw new SplitValidationError('UNSAFE_AMOUNT', lineIndex)
  }

  return {
    subtotalCents,
    cogsCents: totals.cogsCents + quantity * unitCogsCents,
  }
}

export function computeSplit(lines: readonly SplitLine[]): OrderSplit {
  if (lines.length === 0) {
    throw new SplitValidationError('EMPTY_ORDER')
  }
  const { subtotalCents, cogsCents } = lines.reduce(addLine, {
    subtotalCents: 0,
    cogsCents: 0,
  })
  const platformFeeCents = computePlatformFee(subtotalCents)
  // Revision 2: the fee comes out of the provider's markup; the patient pays the subtotal.
  const providerMarginCents = subtotalCents - cogsCents - platformFeeCents
  // Unreachable while every line meets its minimum; kept as a guard on the invariant.
  if (providerMarginCents < 0) {
    throw new SplitValidationError('PRICE_BELOW_MINIMUM')
  }
  return {
    subtotalCents,
    platformFeeCents,
    totalCents: subtotalCents,
    cogsCents,
    providerMarginCents,
  }
}
