import {
  partialPaymentQuote,
  type PartialPaymentLine,
  type PartialPaymentPlan,
  type PartialPaymentQuoteOptions,
  type QuoteTotals,
} from '../money'
import type { PartialPaymentQuoteDto, QuoteTotalsDto } from './responses'

function totalsDto(
  totals: QuoteTotals,
  view: 'provider' | 'patient',
): QuoteTotalsDto {
  const { subtotalCents, totalCents, platformFeeCents } = totals
  // The patient never sees the platform fee (FRONTEND_DESIGN §194).
  if (view === 'patient') return { subtotalCents, totalCents }
  return { subtotalCents, totalCents, platformFeeCents }
}

export interface PartialPaymentQuoteDtoOptions extends PartialPaymentQuoteOptions {
  /**
   * Revision 18.1: the order already has a live back-order, so it can't
   * split again. A shortfall then makes the quote unpayable until restocked.
   */
  hasLiveBackorder?: boolean
}

/**
 * The revision 14 quote DTO for a plan, shaped for the viewer. Revision 18.1:
 * an order that is short again while it has a live back-order gets
 * `payable: false` with `reason: 'awaiting_restock'`, so every payable quote
 * can be paid by sending it back unchanged.
 */
export function partialPaymentQuoteDto(
  plan: Pick<
    PartialPaymentPlan<PartialPaymentLine>,
    'payLines' | 'backorderLines' | 'payable' | 'hasShortfall'
  >,
  view: 'provider' | 'patient',
  { hasLiveBackorder = false, ...options }: PartialPaymentQuoteDtoOptions = {},
): PartialPaymentQuoteDto {
  const { pay, backorder } = partialPaymentQuote(plan, options)
  const totals = {
    pay: totalsDto(pay, view),
    backorder: totalsDto(backorder, view),
    hasShortfall: plan.hasShortfall,
  }
  if (plan.payable && plan.hasShortfall && hasLiveBackorder) {
    return { ...totals, payable: false, reason: 'awaiting_restock' }
  }
  return { ...totals, payable: plan.payable }
}
