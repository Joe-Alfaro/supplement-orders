import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
  type PatientOrderDetailDto,
  type ProviderOrderListItemDto,
  type ProviderOrderDetailDto,
} from '@supplement-orders/domain'

// Revision 14 (FRONTEND_DESIGN §4.10). Local client types per DOMAIN_CONTRACT
// 14.3 to 14.7, until the domain package carries them.

/** The stored statuses plus the derived one (14.3). */
export type UiOrderStatus = OrderStatus | 'awaiting_stock'

export const UI_ORDER_STATUSES = [
  'draft',
  'pending_payment',
  'awaiting_stock',
  'paid',
  'cancelled',
] as const satisfies readonly UiOrderStatus[]

export const UI_STATUS_LABELS: Record<UiOrderStatus, string> = {
  ...ORDER_STATUS_LABELS,
  awaiting_stock: 'Awaiting stock',
}

/** Back-order links on both roles' order DTOs (14.7). */
export interface BackorderLinks {
  splitFromOrderId: number | null
  backorderOrderId: number | null
}

/** Subtotal, fee and total of one side of a partial payment (14.4). */
export interface QuoteSideDto {
  subtotalCents: number
  platformFeeCents: number
  totalCents: number
}

/** What the server quotes for paying the in-stock part now; an empty side is zeros. */
export interface PartialPaymentQuoteDto {
  pay: QuoteSideDto
  backorder: QuoteSideDto
}

export type PatientOrderWithStock = Omit<
  PatientOrderDetailDto,
  'status' | 'lines'
> &
  Partial<BackorderLinks> & {
    status: UiOrderStatus
    partialPaymentQuote?: PartialPaymentQuoteDto
    lines: (PatientOrderDetailDto['lines'][number] & {
      availableQuantity?: number
    })[]
  }

export type ProviderOrderWithLinks = Omit<ProviderOrderDetailDto, 'status'> &
  Partial<BackorderLinks> & { status: UiOrderStatus }

export type ProviderListItem = Omit<ProviderOrderListItemDto, 'status'> & {
  status: UiOrderStatus
}
