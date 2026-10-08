import { computePlatformFee, computeSplit, type SplitLine } from './split'

/** A sent order line, keyed by product so availability can be looked up. */
export interface PartialPaymentLine extends SplitLine {
  productId: number
}

/**
 * Available stock per product id: a Map, or a plain object keyed by id. A
 * product that is missing has nothing available.
 */
export type AvailabilityByProductId =
  ReadonlyMap<number, number> | Readonly<Record<number, number>>

export interface PartialPaymentPlan<T extends PartialPaymentLine> {
  /** Each line at its payable quantity; lines with nothing payable are omitted. */
  payLines: T[]
  /** Each short line at its shortfall, keeping its unit price and cogs snapshot. */
  backorderLines: T[]
  /** At least one unit can be paid for now. */
  payable: boolean
  /** At least one unit is short and would go on a back-order. */
  hasShortfall: boolean
}

export interface QuoteTotals {
  subtotalCents: number
  platformFeeCents: number
  totalCents: number
}

export interface PartialPaymentQuote {
  /** Totals of the in-stock portion: what an available-mode pay charges. */
  pay: QuoteTotals
  /** Totals of the shortfall: what the back-order will cost. */
  backorder: QuoteTotals
}

const NO_TOTALS: QuoteTotals = {
  subtotalCents: 0,
  platformFeeCents: 0,
  totalCents: 0,
}

function availableFor(
  availability: AvailabilityByProductId,
  productId: number,
): number {
  const raw =
    availability instanceof Map
      ? availability.get(productId)
      : (availability as Readonly<Record<number, number>>)[productId]
  // Negative or missing stock means nothing can be paid for.
  return raw === undefined || !Number.isInteger(raw) ? 0 : Math.max(raw, 0)
}

/**
 * Revision 14: splits an order into what current stock can cover now and the
 * shortfall that becomes a back-order. Per line, payable = min(quantity,
 * available) and short = quantity - payable. Duplicate products on one order
 * are rejected upstream, so availability is per line.
 */
export function planPartialPayment<T extends PartialPaymentLine>(
  lines: readonly T[],
  availabilityByProductId: AvailabilityByProductId,
): PartialPaymentPlan<T> {
  const split = lines.map((line) => {
    const payable = Math.min(
      line.quantity,
      availableFor(availabilityByProductId, line.productId),
    )
    return { line, payable, short: line.quantity - payable }
  })
  const payLines = split
    .filter((s) => s.payable > 0)
    .map((s) => ({ ...s.line, quantity: s.payable }))
  const backorderLines = split
    .filter((s) => s.short > 0)
    .map((s) => ({ ...s.line, quantity: s.short }))
  return {
    payLines,
    backorderLines,
    payable: payLines.length > 0,
    hasShortfall: backorderLines.length > 0,
  }
}

function totalsOf(lines: readonly SplitLine[]): QuoteTotals {
  if (lines.length === 0) return NO_TOTALS
  const { subtotalCents, platformFeeCents, totalCents } = computeSplit(lines)
  return { subtotalCents, platformFeeCents, totalCents }
}

export interface SplitFees {
  payFeeCents: number
  backorderFeeCents: number
}

/**
 * Revision 18.4 (L5): splitting conserves the fee the order already carries.
 * The in-stock portion is charged 75 bps of its subtotal rounded up, capped at
 * the order's fee, and the back-order keeps the rest, so it is never negative
 * and the fees across a whole chain add up to the unsplit order's fee. Each
 * half's fee stays within its own rounded-up fee, so neither margin can go
 * negative while every line meets its minimum price.
 */
export function conservedSplitFees(
  orderFeeCents: number,
  paySubtotalCents: number,
): SplitFees {
  const payFeeCents = Math.min(
    computePlatformFee(paySubtotalCents),
    orderFeeCents,
  )
  return { payFeeCents, backorderFeeCents: orderFeeCents - payFeeCents }
}

type PlanHalves = Pick<
  PartialPaymentPlan<PartialPaymentLine>,
  'payLines' | 'backorderLines'
>

export interface PartialPaymentQuoteOptions {
  /**
   * The fee stored on the order being quoted (revision 18.4, L5). When given,
   * the halves split it with conservedSplitFees instead of each being priced
   * as its own order.
   */
  orderFeeCents?: number
}

/**
 * The totals of both halves of a plan. Without `orderFeeCents` each half is
 * priced as its own order: the fee is charged once per order and rounded up,
 * so pay.fee + backorder.fee may exceed the original order's fee by at most
 * 1 cent. With it, the halves conserve that fee exactly (revision 18.4). An
 * empty half is all 0. Takes a plan, or the lines and availability to plan
 * from.
 */
export function partialPaymentQuote(
  plan: PlanHalves,
  options?: PartialPaymentQuoteOptions,
): PartialPaymentQuote
export function partialPaymentQuote(
  lines: readonly PartialPaymentLine[],
  availabilityByProductId: AvailabilityByProductId,
): PartialPaymentQuote
export function partialPaymentQuote(
  planOrLines: PlanHalves | readonly PartialPaymentLine[],
  second?: AvailabilityByProductId | PartialPaymentQuoteOptions,
): PartialPaymentQuote {
  if (Array.isArray(planOrLines)) {
    return partialPaymentQuote(
      planPartialPayment(
        planOrLines as readonly PartialPaymentLine[],
        (second as AvailabilityByProductId | undefined) ?? {},
      ),
    )
  }
  const plan = planOrLines as PlanHalves
  const pay = totalsOf(plan.payLines)
  const backorder = totalsOf(plan.backorderLines)
  const orderFeeCents = (second as PartialPaymentQuoteOptions | undefined)
    ?.orderFeeCents
  if (orderFeeCents === undefined) return { pay, backorder }
  const fees = conservedSplitFees(orderFeeCents, pay.subtotalCents)
  return {
    pay: { ...pay, platformFeeCents: fees.payFeeCents },
    backorder: { ...backorder, platformFeeCents: fees.backorderFeeCents },
  }
}
