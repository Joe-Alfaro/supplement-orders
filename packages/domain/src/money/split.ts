import { SplitValidationError } from './errors'

export const PLATFORM_FEE_BPS = 75

const BPS_DENOMINATOR = 10_000
const HALF_DENOMINATOR = BPS_DENOMINATOR / 2

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

function feeNumerator(subtotalCents: number): number {
  return subtotalCents * PLATFORM_FEE_BPS + HALF_DENOMINATOR
}

/**
 * 75 bps of the subtotal, rounded half up to the nearest cent. Adding half the
 * denominator before flooring rounds half up in pure integer arithmetic.
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
  if (unitPriceCents < unitCogsCents) {
    throw new SplitValidationError('PRICE_BELOW_COGS', lineIndex)
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
  return {
    subtotalCents,
    platformFeeCents,
    totalCents: subtotalCents + platformFeeCents,
    cogsCents,
    providerMarginCents: subtotalCents - cogsCents,
  }
}
