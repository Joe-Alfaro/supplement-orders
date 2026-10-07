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

export interface StockLine {
  quantity: number
  unitPriceCents: number | null
  availableQuantity: number
}

export type PatientOrderWithStock = Omit<
  PatientOrderDetailDto,
  'status' | 'lines'
> &
  Partial<BackorderLinks> & {
    status: UiOrderStatus
    lines: (PatientOrderDetailDto['lines'][number] & {
      availableQuantity?: number
    })[]
  }

export type ProviderOrderWithLinks = Omit<ProviderOrderDetailDto, 'status'> &
  Partial<BackorderLinks> & { status: UiOrderStatus }

/** min(quantity, available); a missing availability means unlimited. */
export function payableQuantity(quantity: number, available?: number) {
  return available === undefined ? quantity : Math.min(quantity, available)
}

export function shortQuantity(quantity: number, available?: number) {
  return quantity - payableQuantity(quantity, available)
}

export interface PayQuote {
  payCents: number
  backorderCents: number
  hasShortfall: boolean
  /** Nothing payable now. */
  nothingPayable: boolean
}

/** Totals of the in-stock part and the rest, in integer cents (the patient total is the subtotal). */
export function quoteAvailable(
  lines: readonly {
    quantity: number
    unitPriceCents: number | null
    availableQuantity?: number
  }[],
): PayQuote {
  const totals = lines.reduce(
    (sum, line) => {
      const price = line.unitPriceCents ?? 0
      const pay = payableQuantity(line.quantity, line.availableQuantity)
      return {
        pay: sum.pay + pay * price,
        rest: sum.rest + (line.quantity - pay) * price,
        short: sum.short + (line.quantity - pay),
        paid: sum.paid + pay,
      }
    },
    { pay: 0, rest: 0, paid: 0, short: 0 },
  )
  return {
    payCents: totals.pay,
    backorderCents: totals.rest,
    hasShortfall: totals.short > 0,
    nothingPayable: totals.paid === 0,
  }
}

export type ProviderListItem = Omit<ProviderOrderListItemDto, 'status'> & {
  status: UiOrderStatus
}
