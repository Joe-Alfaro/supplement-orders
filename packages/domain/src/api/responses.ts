import { z } from 'zod'

// Response DTOs for every endpoint in FRONTEND_DESIGN.md §7.
// Money fields are integer cents with a `Cents` suffix. Timestamps are ISO 8601 strings.
// Each schema is typed against its interface so the two cannot drift.

const id = z.int().positive()
const cents = z.int().nonnegative()
const timestamp = z.string()

export const ROLES = ['provider', 'patient'] as const
export type Role = (typeof ROLES)[number]

export const ORDER_STATUSES = [
  'draft',
  'pending_payment',
  'paid',
  'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

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
 * GET /api/products returns ProductDto[] (provider only: COGS is internal).
 * PATCH /api/products/:id/stock returns the updated ProductDto.
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

/** GET /api/patients returns PatientDto[]; GET /api/patients/:id returns PatientDto. Provider only. */
export interface PatientDto {
  id: number
  userId: number
  providerId: number
  name: string
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
  address: z.string(),
  orderCount: z.int().nonnegative(),
  latestOrderStatus: z.enum(ORDER_STATUSES).nullable(),
})

/** What the patient sees: never COGS or margin. */
export interface OrderTotalsDto {
  subtotalCents: number
  platformFeeCents: number
  /** subtotalCents + platformFeeCents: what the patient pays. */
  totalCents: number
}

/** Provider view of the money: totals plus where every cent goes. */
export interface OrderSplitDto extends OrderTotalsDto {
  cogsCents: number
  /** subtotalCents - cogsCents. cogsCents + providerMarginCents + platformFeeCents === totalCents. */
  providerMarginCents: number
}

const totalsShape = {
  subtotalCents: cents,
  platformFeeCents: cents,
  totalCents: cents,
}

export const orderTotalsDtoSchema: z.ZodType<OrderTotalsDto> =
  z.object(totalsShape)

export const orderSplitDtoSchema: z.ZodType<OrderSplitDto> = z.object({
  ...totalsShape,
  cogsCents: cents,
  providerMarginCents: cents,
})

export interface OrderLineDto {
  productId: number
  productName: string
  sku: string
  quantity: number
  unitPriceCents: number
  /** quantity * unitPriceCents */
  lineTotalCents: number
}

/** Line with the COGS snapshot taken when the line was saved and refreshed on send. */
export interface ProviderOrderLineDto extends OrderLineDto {
  unitCogsCents: number
  /** unitPriceCents - unitCogsCents */
  unitMarginCents: number
}

const lineShape = {
  productId: id,
  productName: z.string(),
  sku: z.string(),
  quantity: z.int().min(1),
  unitPriceCents: cents,
  lineTotalCents: cents,
}

export const orderLineDtoSchema: z.ZodType<OrderLineDto> = z.object(lineShape)

export const providerOrderLineDtoSchema: z.ZodType<ProviderOrderLineDto> =
  z.object({
    ...lineShape,
    unitCogsCents: cents,
    unitMarginCents: cents,
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
}

/**
 * GET /api/orders returns ProviderOrderSummaryDto[] for a provider (own orders, optional
 * patientId filter) and PatientOrderSummaryDto[] for a patient (own non-draft orders).
 * Draft money values are computed live from the current lines; sent orders use the snapshot.
 */
export interface ProviderOrderSummaryDto extends OrderSummaryBase {
  view: 'provider'
  split: OrderSplitDto
}

export interface PatientOrderSummaryDto extends OrderSummaryBase {
  view: 'patient'
  totals: OrderTotalsDto
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
}

export const providerOrderSummaryDtoSchema: z.ZodType<ProviderOrderSummaryDto> =
  z.object({
    ...summaryShape,
    view: z.literal('provider'),
    split: orderSplitDtoSchema,
  })

export const patientOrderSummaryDtoSchema: z.ZodType<PatientOrderSummaryDto> =
  z.object({
    ...summaryShape,
    view: z.literal('patient'),
    totals: orderTotalsDtoSchema,
  })

/**
 * Returned by POST /api/orders (201), PUT /api/orders/:id/lines, POST /api/orders/:id/send,
 * and GET /api/orders/:id when the caller is the order's provider.
 * `payment` and `ledger` are populated once paid; ledger is empty before that.
 */
export interface ProviderOrderDetailDto extends ProviderOrderSummaryDto {
  patientAddress: string
  lines: ProviderOrderLineDto[]
  payment: PaymentDto | null
  ledger: LedgerEntryDto[]
}

/**
 * Returned by GET /api/orders/:id and POST /api/orders/:id/pay when the caller is the
 * order's patient. Contains no COGS, margin, or ledger.
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
    split: orderSplitDtoSchema,
    patientAddress: z.string(),
    lines: z.array(providerOrderLineDtoSchema),
    payment: paymentDtoSchema.nullable(),
    ledger: z.array(ledgerEntryDtoSchema),
  })

export const patientOrderDetailDtoSchema: z.ZodType<PatientOrderDetailDto> =
  z.object({
    ...summaryShape,
    view: z.literal('patient'),
    totals: orderTotalsDtoSchema,
    patientAddress: z.string(),
    lines: z.array(orderLineDtoSchema),
    payment: paymentDtoSchema.nullable(),
  })

export interface DashboardPaidOrderDto {
  orderId: number
  patientId: number
  patientName: string
  paidAt: string
  /** Amount the patient paid (payments.amountCents). */
  totalCents: number
  cogsCents: number
  providerMarginCents: number
  platformFeeCents: number
}

/** GET /api/dashboard (provider only). All-time values for the acting provider. */
export interface DashboardDto {
  /** SUM(payments.amountCents) over this provider's paid orders. */
  gmvCents: number
  /** SUM of provider_margin ledger entries. */
  providerMarginCents: number
  /** SUM of platform_fee ledger entries. */
  platformFeeCents: number
  /** Newest first. */
  paidOrders: DashboardPaidOrderDto[]
}

export const dashboardDtoSchema: z.ZodType<DashboardDto> = z.object({
  gmvCents: cents,
  providerMarginCents: cents,
  platformFeeCents: cents,
  paidOrders: z.array(
    z.object({
      orderId: id,
      patientId: id,
      patientName: z.string(),
      paidAt: timestamp,
      totalCents: cents,
      cogsCents: cents,
      providerMarginCents: cents,
      platformFeeCents: cents,
    }),
  ),
})
