import { z } from 'zod'

// Response DTOs for every endpoint in FRONTEND_DESIGN.md §7.
// Money fields are integer cents with a `Cents` suffix. Timestamps are ISO 8601 strings.
// Each schema is typed against its interface so the two cannot drift.

const id = z.int().positive()
const cents = z.int().nonnegative()
const timestamp = z.string()
const isoDate = z.iso.date()

export const ROLES = ['provider', 'patient'] as const
export type Role = (typeof ROLES)[number]

export const ORDER_STATUSES = [
  'draft',
  'pending_payment',
  'paid',
  'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** Human labels for order statuses: the only wording the UI and API messages use. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Draft',
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

export const LEDGER_ENTRY_TYPES = [
  'cogs',
  'provider_margin',
  'platform_fee',
] as const

/** GET /api/users returns UserDto[] (no X-User-Id required). */
export interface UserDto {
  id: number
  name: string
  role: Role
  /** Set when role is provider. */
  providerId: number | null
  /** Set when role is patient. */
  patientId: number | null
}

export const userDtoSchema: z.ZodType<UserDto> = z.object({
  id,
  name: z.string(),
  role: z.enum(ROLES),
  providerId: id.nullable(),
  patientId: id.nullable(),
})

/**
 * GET /api/products returns Page<ProductDto> (provider only: wholesale cost is internal).
 * Stock is read-only; it decreases only when an order is paid.
 */
export interface ProductDto {
  id: number
  sku: string
  name: string
  cogsCents: number
  stockQuantity: number
}

export const productDtoSchema: z.ZodType<ProductDto> = z.object({
  id,
  sku: z.string(),
  name: z.string(),
  cogsCents: cents,
  stockQuantity: z.int().nonnegative(),
})

/**
 * One page of a list. `total` counts every match for the query, not just this
 * page; `offset` and `limit` echo the parsed query. An offset past the end
 * returns empty `items` with the real `total`.
 */
export interface Page<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

export function pageSchema<T>(item: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.object({
    items: z.array(item),
    total: z.int().nonnegative(),
    offset: z.int().nonnegative(),
    limit: z.int().min(1),
  })
}

/**
 * GET /api/patients returns Page<PatientDto> (provider only, own patients).
 * GET /api/patients/:id returns PatientDto.
 */
export interface PatientDto {
  id: number
  userId: number
  providerId: number
  name: string
  /** Calendar date, `YYYY-MM-DD`. With the name, how clinicians identify a patient. */
  dateOfBirth: string
  /** Shipping address. Shown, but not searched. */
  address: string
  orderCount: number
  /** Status of the most recently created order, or null with no orders. */
  latestOrderStatus: OrderStatus | null
}

export const patientDtoSchema: z.ZodType<PatientDto> = z.object({
  id,
  userId: id,
  providerId: id,
  name: z.string(),
  dateOfBirth: isoDate,
  address: z.string(),
  orderCount: z.int().nonnegative(),
  latestOrderStatus: z.enum(ORDER_STATUSES).nullable(),
})

/**
 * Provider view of the money (revision 2: the fee comes out of the provider's markup).
 * totalCents === subtotalCents, and
 * cogsCents + platformFeeCents + providerMarginCents === totalCents.
 */
export interface OrderSplitDto {
  subtotalCents: number
  platformFeeCents: number
  /** What the patient pays: exactly the subtotal. */
  totalCents: number
  cogsCents: number
  /** subtotalCents - cogsCents - platformFeeCents; never negative for a valid order. */
  providerMarginCents: number
}

export const orderSplitDtoSchema: z.ZodType<OrderSplitDto> = z.object({
  subtotalCents: cents,
  platformFeeCents: cents,
  totalCents: cents,
  cogsCents: cents,
  providerMarginCents: cents,
})

/** A patient-visible line. Patients only see sent orders, so lines are complete. */
export interface OrderLineDto {
  productId: number
  productName: string
  sku: string
  quantity: number
  unitPriceCents: number
  /** quantity * unitPriceCents */
  lineTotalCents: number
}

export const orderLineDtoSchema: z.ZodType<OrderLineDto> = z.object({
  productId: id,
  productName: z.string(),
  sku: z.string(),
  quantity: z.int().min(1),
  unitPriceCents: cents,
  lineTotalCents: cents,
})

/**
 * A provider-visible line, in saved order. Draft lines may be incomplete: no
 * product yet (product fields and unitCogsCents null) or no price yet
 * (unitPriceCents and lineTotalCents null). Sent orders always have complete lines.
 */
export interface ProviderOrderLineDto {
  productId: number | null
  productName: string | null
  sku: string | null
  quantity: number
  unitPriceCents: number | null
  /** quantity * unitPriceCents, or null without a price. */
  lineTotalCents: number | null
  /** Wholesale cost snapshot, taken on save and refreshed on send. Null without a product. */
  unitCogsCents: number | null
  /**
   * Net markup on wholesale cost, markupBpsFromPrice(unitCogsCents, unitPriceCents).
   * Uncapped (30000 = 300%). Negative when priced below cost plus the fee. Null
   * without a product or a price, and when the wholesale cost is 0 (undefined markup).
   */
  markupBps: number | null
  /** minUnitPriceCents(unitCogsCents); null without a product. */
  minUnitPriceCents: number | null
  /** The product's current stock (live, not a snapshot); null without a product. */
  stockQuantity: number | null
}

export const providerOrderLineDtoSchema: z.ZodType<ProviderOrderLineDto> =
  z.object({
    productId: id.nullable(),
    productName: z.string().nullable(),
    sku: z.string().nullable(),
    quantity: z.int().min(1),
    unitPriceCents: cents.nullable(),
    lineTotalCents: cents.nullable(),
    unitCogsCents: cents.nullable(),
    markupBps: z.int().nullable(),
    minUnitPriceCents: cents.nullable(),
    stockQuantity: z.int().nonnegative().nullable(),
  })

export interface PaymentDto {
  id: number
  amountCents: number
  /** Reference returned by the (fake) payment gateway. */
  reference: string
  createdAt: string
}

export const paymentDtoSchema: z.ZodType<PaymentDto> = z.object({
  id,
  amountCents: cents,
  reference: z.string(),
  createdAt: timestamp,
})

export interface LedgerEntryDto {
  id: number
  type: (typeof LEDGER_ENTRY_TYPES)[number]
  amountCents: number
  createdAt: string
}

export const ledgerEntryDtoSchema: z.ZodType<LedgerEntryDto> = z.object({
  id,
  type: z.enum(LEDGER_ENTRY_TYPES),
  amountCents: cents,
  createdAt: timestamp,
})

interface OrderSummaryBase {
  id: number
  status: OrderStatus
  patientId: number
  patientName: string
  providerId: number
  providerName: string
  createdAt: string
  sentAt: string | null
  paidAt: string | null
  /** Set when a provider cancelled the order (from pending_payment; revision 6 also allowed drafts). */
  cancelledAt: string | null
  /**
   * The quote version (revision 9): 0 for a never-sent draft, incremented on every
   * send, including a re-send after reopen. Pay must echo it as `expectedRevision`.
   */
  revision: number
}

/**
 * Patients see their sent orders: pending_payment, paid, and cancelled after
 * sending. Drafts, including drafts cancelled before sending, are never shown to them.
 *
 * GET /api/orders returns ProviderOrderSummaryDto[] for a provider (own orders, optional
 * patientId filter) and PatientOrderSummaryDto[] for a patient (own non-draft orders).
 * Sent orders use the split snapshotted on send. Drafts are priced live from their
 * lines, and `split` is null while the draft would not pass send validation
 * (no lines, an incomplete line, or a price below its minimum).
 */
export interface ProviderOrderSummaryDto extends OrderSummaryBase {
  view: 'provider'
  split: OrderSplitDto | null
}

/** The patient sees only what they pay: no fee, cost, or margin. */
export interface PatientOrderSummaryDto extends OrderSummaryBase {
  view: 'patient'
  totalCents: number
}

export type OrderSummaryDto = ProviderOrderSummaryDto | PatientOrderSummaryDto

const summaryShape = {
  id,
  status: z.enum(ORDER_STATUSES),
  patientId: id,
  patientName: z.string(),
  providerId: id,
  providerName: z.string(),
  createdAt: timestamp,
  sentAt: timestamp.nullable(),
  paidAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
  revision: z.int().nonnegative(),
}

export const providerOrderSummaryDtoSchema: z.ZodType<ProviderOrderSummaryDto> =
  z.object({
    ...summaryShape,
    view: z.literal('provider'),
    split: orderSplitDtoSchema.nullable(),
  })

export const patientOrderSummaryDtoSchema: z.ZodType<PatientOrderSummaryDto> =
  z.object({
    ...summaryShape,
    view: z.literal('patient'),
    totalCents: cents,
  })

/**
 * Returned by POST /api/orders (201), PUT /api/orders/:id/lines, POST /api/orders/:id/send,
 * POST /api/orders/:id/cancel, POST /api/orders/:id/reopen, and GET /api/orders/:id when
 * the caller is the order's provider. DELETE /api/orders/:id returns 204 with no body.
 * `payment` and `ledger` are populated once paid; ledger is empty before that.
 */
export interface ProviderOrderDetailDto extends ProviderOrderSummaryDto {
  /** `YYYY-MM-DD`, so the provider can confirm the right patient before sending. */
  patientDateOfBirth: string
  patientAddress: string
  lines: ProviderOrderLineDto[]
  payment: PaymentDto | null
  ledger: LedgerEntryDto[]
}

/**
 * Returned by GET /api/orders/:id and POST /api/orders/:id/pay when the caller is the
 * order's patient. Contains no wholesale cost, platform fee, margin, or ledger.
 */
export interface PatientOrderDetailDto extends PatientOrderSummaryDto {
  patientAddress: string
  lines: OrderLineDto[]
  payment: PaymentDto | null
}

export type OrderDetailDto = ProviderOrderDetailDto | PatientOrderDetailDto

export const providerOrderDetailDtoSchema: z.ZodType<ProviderOrderDetailDto> =
  z.object({
    ...summaryShape,
    view: z.literal('provider'),
    split: orderSplitDtoSchema.nullable(),
    patientDateOfBirth: isoDate,
    patientAddress: z.string(),
    lines: z.array(providerOrderLineDtoSchema),
    payment: paymentDtoSchema.nullable(),
    ledger: z.array(ledgerEntryDtoSchema),
  })

export const patientOrderDetailDtoSchema: z.ZodType<PatientOrderDetailDto> =
  z.object({
    ...summaryShape,
    view: z.literal('patient'),
    totalCents: cents,
    patientAddress: z.string(),
    lines: z.array(orderLineDtoSchema),
    payment: paymentDtoSchema.nullable(),
  })

/**
 * The days a dashboard response covers, resolved by the server in `timeZone`
 * (revision 11a-v2). `from` and `to` are inclusive YYYY-MM-DD, both null for
 * `all`.
 */
export interface DashboardRangeDto {
  preset: 'month' | 'last30' | 'all' | 'custom'
  from: string | null
  to: string | null
  timeZone: string
}

/**
 * GET /api/dashboard (provider only). Totals for the acting provider's orders
 * paid inside `range`, read from one database snapshot (revision 9). The
 * paid-order list was removed; use GET /api/orders?status=paid for it.
 */
export interface DashboardDto {
  /** SUM(payments.amountCents) over this provider's paid orders in range. */
  gmvCents: number
  /** SUM of provider_margin ledger entries in range. */
  providerMarginCents: number
  /** SUM of platform_fee ledger entries in range. */
  platformFeeCents: number
  range: DashboardRangeDto
}

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const dashboardRangeDtoSchema: z.ZodType<DashboardRangeDto> = z.object({
  preset: z.enum(['month', 'last30', 'all', 'custom']),
  from: dayString.nullable(),
  to: dayString.nullable(),
  timeZone: z.string().min(1),
})

export const dashboardDtoSchema: z.ZodType<DashboardDto> = z.object({
  gmvCents: cents,
  providerMarginCents: cents,
  platformFeeCents: cents,
  range: dashboardRangeDtoSchema,
})

export type ProductPageDto = Page<ProductDto>
export type PatientPageDto = Page<PatientDto>

export const productPageDtoSchema = pageSchema(productDtoSchema)
export const patientPageDtoSchema = pageSchema(patientDtoSchema)

/**
 * One row of GET /api/orders?status=... (provider only, own orders). `totalCents`
 * and `sentAt` are null for drafts and for orders cancelled or reopened before
 * sending. Days waiting is left to the client, computed from `sentAt`.
 */
export interface ProviderOrderListItemDto {
  id: number
  patientId: number
  patientName: string
  /** `YYYY-MM-DD` */
  patientDateOfBirth: string
  status: OrderStatus
  /** The amount the patient pays, snapshotted on send. */
  totalCents: number | null
  createdAt: string
  sentAt: string | null
  paidAt: string | null
  cancelledAt: string | null
}

export const providerOrderListItemDtoSchema: z.ZodType<ProviderOrderListItemDto> =
  z.object({
    id,
    patientId: id,
    patientName: z.string(),
    patientDateOfBirth: isoDate,
    status: z.enum(ORDER_STATUSES),
    totalCents: cents.nullable(),
    createdAt: timestamp,
    sentAt: timestamp.nullable(),
    paidAt: timestamp.nullable(),
    cancelledAt: timestamp.nullable(),
  })

export type ProviderOrderListPageDto = Page<ProviderOrderListItemDto>
export const providerOrderListPageDtoSchema = pageSchema(
  providerOrderListItemDtoSchema,
)

/** @deprecated Revision 8 generalized this to ProviderOrderListItemDto. */
export type AwaitingPaymentOrderDto = ProviderOrderListItemDto
/** @deprecated Use ProviderOrderListPageDto. */
export type AwaitingPaymentPageDto = ProviderOrderListPageDto
/** @deprecated Use providerOrderListItemDtoSchema. */
export const awaitingPaymentOrderDtoSchema = providerOrderListItemDtoSchema
/** @deprecated Use providerOrderListPageDtoSchema. */
export const awaitingPaymentPageDtoSchema = providerOrderListPageDtoSchema
