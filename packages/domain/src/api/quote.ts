import {
  partialPaymentQuote,
  type PartialPaymentLine,
  type PartialPaymentPlan,
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

/** The revision 14 quote DTO for a plan, shaped for the viewer. */
export function partialPaymentQuoteDto(
  plan: Pick<
    PartialPaymentPlan<PartialPaymentLine>,
    'payLines' | 'backorderLines' | 'payable' | 'hasShortfall'
  >,
  view: 'provider' | 'patient',
): PartialPaymentQuoteDto {
  const { pay, backorder } = partialPaymentQuote(plan)
  return {
    pay: totalsDto(pay, view),
    backorder: totalsDto(backorder, view),
    payable: plan.payable,
    hasShortfall: plan.hasShortfall,
  }
}
