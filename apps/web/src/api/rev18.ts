import type {
  DashboardDto,
  PartialPaymentQuoteDto,
} from '@supplement-orders/domain'

// Revision 18 wire shapes. Temporary local copies of what rev18-api adds to the
// domain package; replace these with the domain types when the branches merge.

/** 18.1: why a quote cannot be paid. */
export type QuoteUnpayableReason = 'awaiting_restock'

export interface PartialPaymentQuote18Dto extends PartialPaymentQuoteDto {
  reason?: QuoteUnpayableReason
}

/** 18.2: one stranded payment attempt. No patient fields. */
export type PaymentAttemptStatus = 'pending' | 'succeeded' | 'conflict'

export interface PaymentAttemptDto {
  id: number
  orderId: number
  providerName: string
  amountCents: number
  status: PaymentAttemptStatus
  ageSeconds: number
}

export type ReconcileOutcome = 'succeeded' | 'declined' | 'abandoned'

export interface ReconcileResultDto {
  id: number
  outcome: ReconcileOutcome
}

/** 18.3: one row of the provider's "Sold by product" table. */
export interface SoldProductDto {
  productId: number
  productName: string
  units: number
  revenueCents: number
}

export interface Dashboard18Dto extends DashboardDto {
  /** Optional only until the domain DTO makes it required on merge. */
  soldByProduct?: SoldProductDto[]
}
