import { z } from 'zod'
import {
  ACCOUNT_TYPES,
  JOURNAL_KINDS,
  NORMAL_BALANCES,
  type AccountType,
  type JournalKind,
  type NormalBalance,
} from '../money/journal'

// Response DTOs for every endpoint in FRONTEND_DESIGN.md §7.
// Money fields are integer cents with a `Cents` suffix. Timestamps are ISO 8601 strings.
// Each schema is typed against its interface so the two cannot drift.

const id = z.int().positive()
const cents = z.int().nonnegative()
const timestamp = z.string()
const isoDate = z.iso.date()

/** Revision 13 adds admin, who manages stock and has no provider or patient profile. */
export const ROLES = ['provider', 'patient', 'admin'] as const
export type Role = (typeof ROLES)[number]

/** The statuses stored on an order row (the database enum). */
export const STORED_ORDER_STATUSES = [
  'draft',
  'pending_payment',
  'paid',
  'cancelled',
] as const
export type StoredOrderStatus = (typeof STORED_ORDER_STATUSES)[number]

/**
 * The statuses the API reports and filters on. Revision 14 adds the derived
 * `awaiting_stock`: a stored pending_payment order none of whose lines has a
 * product in stock (read from the orders_with_status view, never stored).
 */
export const ORDER_STATUSES = [
  'draft',
  'pending_payment',
  'awaiting_stock',
  'paid',
  'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * Payment attempt statuses (the database enum). Revision 18.2 adds
 * `abandoned`: reconciled by an admin after the gateway never saw the charge
 * within the safety window; its stock was released.
 */
export const PAYMENT_ATTEMPT_STATUSES = [
  'pending',
  'succeeded',
  'declined',
  'conflict',
  'abandoned',
] as const
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number]

/** Human labels for order statuses: the only wording the UI and API messages use. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Draft',
  pending_payment: 'Awaiting payment',
  awaiting_stock: 'Awaiting stock',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

/** GET /api/users/me returns the caller's own UserDto (401 without a known X-User-Id). */
export interface UserDto {
  id: number
  name: string
  role: Role
  /** Set when role is provider. */
  providerId: number | null
  /** Set when role is patient. */
  patientId: number | null
  // An admin has neither.
}

export const userDtoSchema: z.ZodType<UserDto> = z.object({
  id,
  name: z.string(),
  role: z.enum(ROLES),
  providerId: id.nullable(),
  patientId: id.nullable(),
})

/**
 * GET /api/users/sign-in-options returns SignInOptionDto[] (no X-User-Id
 * required): the curated demo personas, with no profile ids.
 */
export interface SignInOptionDto {
  id: number
  name: string
  role: Role
}

export const signInOptionDtoSchema: z.ZodType<SignInOptionDto> = z.object({
  id,
  name: z.string(),
  role: z.enum(ROLES),
})

/**
 * GET /api/products returns Page<ProductDto> (provider only: wholesale cost is internal).
 * Stock is read-only here; only an admin changes it (see AdminProductDto).
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

/** Totals of one half of a partial-payment quote. */
export interface QuoteTotalsDto {
  subtotalCents: number
  totalCents: number
  /** Provider views only: the patient never sees the platform fee. */
  platformFeeCents?: number
}

/**
 * Revision 14: what a pay can charge right now, for an order awaiting payment
 * or stock, from live stock. `pay` covers min(quantity, available) per line:
 * its totalCents is the `expectedTotalCents` of an `available` pay.
 * `backorder` is the shortfall a partial pay would move to a back-order.
 * Pay `full` only when `hasShortfall` is false; `available` only when
 * `payable` is true. Each half is priced as its own order.
 */
export interface PartialPaymentQuoteDto {
  pay: QuoteTotalsDto
  backorder: QuoteTotalsDto
  /**
   * The quote can be paid now. False when nothing is in stock, and (revision
   * 18.1) when the order is short again while it already has a live
   * back-order, which `reason` then explains.
   */
  payable: boolean
  /** At least one unit is short. */
  hasShortfall: boolean
  /**
   * Revision 18.1: set only when the order is short while it already has a
   * live back-order (`backorderOrderId`), so it can't split again; `payable`
   * is then false, and the order can be paid once restocked.
   */
  reason?: QuoteUnpayableReason
}

/** Revision 18.1: why a quote with stock is still not payable. */
export const QUOTE_UNPAYABLE_REASONS = ['awaiting_restock'] as const
export type QuoteUnpayableReason = (typeof QUOTE_UNPAYABLE_REASONS)[number]

const quoteTotalsDtoSchema: z.ZodType<QuoteTotalsDto> = z.object({
  subtotalCents: cents,
  totalCents: cents,
  platformFeeCents: cents.optional(),
})

export const partialPaymentQuoteDtoSchema: z.ZodType<PartialPaymentQuoteDto> =
  z.object({
    pay: quoteTotalsDtoSchema,
    backorder: quoteTotalsDtoSchema,
    payable: z.boolean(),
    hasShortfall: z.boolean(),
    reason: z.enum(QUOTE_UNPAYABLE_REASONS).optional(),
  })

/** A patient-visible line. Patients only see sent orders, so lines are complete. */
export interface OrderLineDto {
  /** The order line's id; INSUFFICIENT_STOCK availability refers to it (revision 14). */
  lineId: number
  productId: number
  productName: string
  sku: string
  quantity: number
  unitPriceCents: number
  /** quantity * unitPriceCents */
  lineTotalCents: number
  /**
   * Revision 14: the product's available stock now (raw, uncapped) while the
   * order awaits payment or stock; null once paid or cancelled.
   */
  availableQuantity: number | null
  /** min(quantity, availableQuantity) while awaiting payment or stock, else null. */
  payableQuantity: number | null
  /** quantity - payableQuantity while awaiting payment or stock, else null. */
  shortQuantity: number | null
}

export const orderLineDtoSchema: z.ZodType<OrderLineDto> = z.object({
  lineId: id,
  productId: id,
  productName: z.string(),
  sku: z.string(),
  quantity: z.int().min(1),
  unitPriceCents: cents,
  lineTotalCents: cents,
  availableQuantity: z.int().nonnegative().nullable(),
  payableQuantity: z.int().nonnegative().nullable(),
  shortQuantity: z.int().nonnegative().nullable(),
})

/**
 * A provider-visible line, in saved order. Draft lines may be incomplete: no
 * product yet (product fields and unitCogsCents null) or no price yet
 * (unitPriceCents and lineTotalCents null). Sent orders always have complete lines.
 */
export interface ProviderOrderLineDto {
  /** The order line's id (revision 14). */
  lineId: number
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
  /**
   * Revision 14: the product's available stock (the same live value as
   * stockQuantity), so the builder can warn when quantity exceeds it. Saving a
   * draft never checks stock; send asks for an acknowledgement instead.
   */
  availableQuantity: number | null
  /** min(quantity, availableQuantity) from live stock; null without a product. */
  payableQuantity: number | null
  /** quantity - payableQuantity; null without a product. */
  shortQuantity: number | null
}

export const providerOrderLineDtoSchema: z.ZodType<ProviderOrderLineDto> =
  z.object({
    lineId: id,
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
    availableQuantity: z.int().nonnegative().nullable(),
    payableQuantity: z.int().nonnegative().nullable(),
    shortQuantity: z.int().nonnegative().nullable(),
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

/**
 * Revision 16: one line of a journal. Exactly one of debitCents and creditCents
 * is set (both positive); a posting is never 0.
 */
export interface JournalPostingDto {
  accountCode: string
  accountName: string
  debitCents: number | null
  creditCents: number | null
}

export const journalPostingDtoSchema: z.ZodType<JournalPostingDto> = z.object({
  accountCode: z.string(),
  accountName: z.string(),
  debitCents: cents.nullable(),
  creditCents: cents.nullable(),
})

/** Revision 16: a balanced journal; its debits always equal its credits. */
export interface JournalDto {
  id: number
  postedAt: string
  memo: string
  postings: JournalPostingDto[]
}

export const journalDtoSchema: z.ZodType<JournalDto> = z.object({
  id,
  postedAt: timestamp,
  memo: z.string(),
  postings: z.array(journalPostingDtoSchema),
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
   * A partial pay bumps it too (revision 14).
   */
  revision: number
  /** Revision 14: the order this back-order was split from, or null. */
  splitFromOrderId: number | null
  /** Revision 14: this order's back-order (its direct child), or null. */
  backorderOrderId: number | null
  /**
   * Revision 15.3: the unpaid order this back-order was split from, while this
   * one awaits payment or stock; null otherwise. A chain pays in order, so pay
   * answers 409 PRIOR_ORDER_UNPAID until that order is paid.
   */
  blockedByOrderId: number | null
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
  splitFromOrderId: id.nullable(),
  backorderOrderId: id.nullable(),
  blockedByOrderId: id.nullable(),
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
 * Revision 15.1: an unresolved payment attempt on the order (pending, succeeded
 * without a recorded payment, or in conflict). The patient completes it by
 * paying again with exactly this revision and amount (`mode: 'full'`), which
 * never starts a new charge.
 */
export interface PaymentInProgressDto {
  revision: number
  amountCents: number
}

export const paymentInProgressDtoSchema: z.ZodType<PaymentInProgressDto> =
  z.object({
    revision: z.int().min(1),
    amountCents: cents,
  })

/** Revision 15 fields shared by both detail views. */
interface OrderDetailExtras {
  /** Revision 15.1: set while a payment attempt is unresolved, else null. */
  paymentInProgress: PaymentInProgressDto | null
  /**
   * Revision 15.3: the status of this order's back-order (`backorderOrderId`),
   * or null without one. A cancelled original whose back-order is cancelled
   * shows "Back-order #B was cancelled with this order."
   */
  backorderStatus: OrderStatus | null
}

const detailExtrasShape = {
  paymentInProgress: paymentInProgressDtoSchema.nullable(),
  backorderStatus: z.enum(ORDER_STATUSES).nullable(),
}

/**
 * Returned by POST /api/orders (201), PUT /api/orders/:id/lines, POST /api/orders/:id/send,
 * POST /api/orders/:id/cancel, POST /api/orders/:id/reopen, and GET /api/orders/:id when
 * the caller is the order's provider. DELETE /api/orders/:id returns 204 with no body.
 * `payment` and `journal` are set once paid and null before that. Revision 16:
 * a paid order's `split` is read from its journal's postings.
 */
export interface ProviderOrderDetailDto
  extends ProviderOrderSummaryDto, OrderDetailExtras {
  /** `YYYY-MM-DD`, so the provider can confirm the right patient before sending. */
  patientDateOfBirth: string
  patientAddress: string
  lines: ProviderOrderLineDto[]
  payment: PaymentDto | null
  /** Revision 16: the patient payment's journal; replaces `ledger`. */
  journal: JournalDto | null
  /** Revision 14: set while the order awaits payment or stock, else null. */
  partialPaymentQuote: PartialPaymentQuoteDto | null
}

/**
 * Returned by GET /api/orders/:id and POST /api/orders/:id/pay when the caller is the
 * order's patient. Contains no wholesale cost, platform fee, margin, journal or
 * posting.
 */
export interface PatientOrderDetailDto
  extends PatientOrderSummaryDto, OrderDetailExtras {
  patientAddress: string
  lines: OrderLineDto[]
  payment: PaymentDto | null
  /** Revision 14: set while the order awaits payment or stock, else null. */
  partialPaymentQuote: PartialPaymentQuoteDto | null
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
    journal: journalDtoSchema.nullable(),
    partialPaymentQuote: partialPaymentQuoteDtoSchema.nullable(),
    ...detailExtrasShape,
  })

export const patientOrderDetailDtoSchema: z.ZodType<PatientOrderDetailDto> =
  z.object({
    ...summaryShape,
    view: z.literal('patient'),
    totalCents: cents,
    patientAddress: z.string(),
    lines: z.array(orderLineDtoSchema),
    payment: paymentDtoSchema.nullable(),
    partialPaymentQuote: partialPaymentQuoteDtoSchema.nullable(),
    ...detailExtrasShape,
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
  /** Revision 16: Cash debits on this provider's payment journals in range. */
  gmvCents: number
  /** Credits to this provider's payable account in range. */
  providerMarginCents: number
  /** Platform fee revenue credits on this provider's journals in range. */
  platformFeeCents: number
  /** Revision 16: the payable account's balance, all time (never date-filtered). */
  owedToYouCents: number
  /**
   * Revision 18.3: units and revenue per product over this provider's orders
   * paid in range, by revenue descending (then name, then product id).
   */
  soldByProduct: SoldByProductDto[]
  range: DashboardRangeDto
}

/** One row of the dashboard's "Sold by product" table (revision 18.3). */
export interface SoldByProductDto {
  productId: number
  productName: string
  unitsSold: number
  /** The sum of line totals (quantity × unit price) on paid orders. */
  revenueCents: number
}

export const soldByProductDtoSchema: z.ZodType<SoldByProductDto> = z.object({
  productId: id,
  productName: z.string(),
  unitsSold: z.int().nonnegative(),
  revenueCents: cents,
})

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
  owedToYouCents: cents,
  soldByProduct: z.array(soldByProductDtoSchema),
  range: dashboardRangeDtoSchema,
})

export type ProductPageDto = Page<ProductDto>
export type PatientPageDto = Page<PatientDto>

export const productPageDtoSchema = pageSchema(productDtoSchema)

/**
 * Revision 13 (admin only). GET /api/admin/products returns
 * Page<AdminProductDto>; POST .../stock/increment and PUT .../stock return the
 * updated AdminProductDto. `stockQuantity` is available stock: whatever
 * unresolved payment attempts hold is already deducted.
 */
export interface AdminProductDto {
  id: number
  name: string
  wholesaleCostCents: number
  stockQuantity: number
}

export const adminProductDtoSchema: z.ZodType<AdminProductDto> = z.object({
  id,
  name: z.string(),
  wholesaleCostCents: cents,
  stockQuantity: z.int().nonnegative(),
})

export type AdminProductPageDto = Page<AdminProductDto>
export const adminProductPageDtoSchema = pageSchema(adminProductDtoSchema)
export const patientPageDtoSchema = pageSchema(patientDtoSchema)

/**
 * Revision 16 (admin only): one row of the trial balance. `debitsCents` and
 * `creditsCents` are the account's totals (both positive); `balanceCents` is
 * signed toward its normal balance (debits - credits for a debit-normal
 * account, credits - debits for a credit-normal one).
 */
export interface AdminAccountDto {
  id: number
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  /** Set only on provider payable accounts. */
  providerId: number | null
  debitsCents: number
  creditsCents: number
  balanceCents: number
}

export const adminAccountDtoSchema: z.ZodType<AdminAccountDto> = z.object({
  id,
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  normalBalance: z.enum(NORMAL_BALANCES),
  providerId: id.nullable(),
  debitsCents: cents,
  creditsCents: cents,
  balanceCents: z.int(),
})

/**
 * GET /api/admin/accounts: every account ordered by code, and the ledger's
 * total debits and credits, which are always equal.
 */
export interface AdminTrialBalanceDto {
  accounts: AdminAccountDto[]
  totals: { debitsCents: number; creditsCents: number }
}

export const adminTrialBalanceDtoSchema: z.ZodType<AdminTrialBalanceDto> =
  z.object({
    accounts: z.array(adminAccountDtoSchema),
    totals: z.object({ debitsCents: cents, creditsCents: cents }),
  })

/** One row of GET /api/admin/journals (newest first). */
export interface AdminJournalDto extends JournalDto {
  kind: JournalKind
  paymentId: number | null
  orderId: number | null
  providerName: string | null
}

export const adminJournalDtoSchema: z.ZodType<AdminJournalDto> = z.object({
  id,
  kind: z.enum(JOURNAL_KINDS),
  postedAt: timestamp,
  memo: z.string(),
  postings: z.array(journalPostingDtoSchema),
  paymentId: id.nullable(),
  orderId: id.nullable(),
  providerName: z.string().nullable(),
})

export type AdminJournalPageDto = Page<AdminJournalDto>
export const adminJournalPageDtoSchema = pageSchema(adminJournalDtoSchema)

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
  /** Revision 14 links, as on the order summary. */
  splitFromOrderId: number | null
  backorderOrderId: number | null
  /** Revision 15.3, as on the order summary. */
  blockedByOrderId: number | null
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
    splitFromOrderId: id.nullable(),
    backorderOrderId: id.nullable(),
    blockedByOrderId: id.nullable(),
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

/**
 * Revision 18.2 (admin only): one row of GET /api/admin/payment-attempts. No
 * patient fields. `ageSeconds` is measured from `createdAt` on the server's
 * clock. `hasPayment` is true once a payment records the attempt.
 */
export interface AdminPaymentAttemptDto {
  id: number
  orderId: number
  providerName: string
  amountCents: number
  status: PaymentAttemptStatus
  hasPayment: boolean
  createdAt: string
  ageSeconds: number
  reconciledAt: string | null
}

export const adminPaymentAttemptDtoSchema: z.ZodType<AdminPaymentAttemptDto> =
  z.object({
    id,
    orderId: id,
    providerName: z.string(),
    amountCents: cents,
    status: z.enum(PAYMENT_ATTEMPT_STATUSES),
    hasPayment: z.boolean(),
    createdAt: timestamp,
    ageSeconds: z.int().nonnegative(),
    reconciledAt: timestamp.nullable(),
  })

/** GET /api/admin/payment-attempts returns a plain array (no paging). */
export const adminPaymentAttemptListDtoSchema = z.array(
  adminPaymentAttemptDtoSchema,
)

/**
 * What POST /api/admin/payment-attempts/:id/reconcile did (revision 18.2):
 * `finalized` recorded the payment the gateway already took, `declined` and
 * `abandoned` released the attempt's stock, and `unchanged` means it was
 * already resolved (reconciling is idempotent).
 */
export const RECONCILE_OUTCOMES = [
  'finalized',
  'declined',
  'abandoned',
  'unchanged',
] as const
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number]

export interface ReconcilePaymentAttemptDto {
  outcome: ReconcileOutcome
  attempt: AdminPaymentAttemptDto
}

export const reconcilePaymentAttemptDtoSchema: z.ZodType<ReconcilePaymentAttemptDto> =
  z.object({
    outcome: z.enum(RECONCILE_OUTCOMES),
    attempt: adminPaymentAttemptDtoSchema,
  })
