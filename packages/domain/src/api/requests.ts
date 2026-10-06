import { z } from 'zod'
import { ORDER_STATUSES } from './responses'

/** Every request except GET /api/users and GET /api/health carries this header. */
export const USER_ID_HEADER = 'X-User-Id'

const id = z.int().positive()

/** Route params such as `:id` and `:patientId` arrive as strings. */
export const idParamSchema = z.coerce.number().pipe(id)

export const PAGE_LIMIT_DEFAULT = 25
export const PAGE_LIMIT_MAX = 100
export const SEARCH_MAX_LENGTH = 100

/**
 * Client-side shape of a list query for GET /api/products and GET /api/patients.
 * Products: `q` matches name or SKU. Patients: `q` matches the name, within
 * the signed-in provider's patients, and additionally the exact date of birth
 * when the whole `q` is a valid calendar date (see `parseDateOfBirthQuery`);
 * address is not searched. Text matching is a case-insensitive substring;
 * `%` and `_` are literal characters. Results are ordered by name,
 * then id.
 */
export interface ListQuery {
  q?: string
  offset?: number
  limit?: number
}

/** A list query after parsing. `q` is null when absent or blank after trimming. */
export interface ParsedListQuery {
  q: string | null
  offset: number
  limit: number
}

/** Raw query-string values as Express delivers them. */
export interface ListQueryParams {
  q?: unknown
  offset?: unknown
  limit?: unknown
}

/** Digits only, so "", "1.5", "-1", "1e3" and repeated params are rejected. */
function intParam(min: number, max: number, fallback: number) {
  return z
    .string()
    .regex(/^\d+$/, 'Must be a whole number')
    .transform(Number)
    .pipe(z.int().min(min).max(max))
    .optional()
    .transform((v) => v ?? fallback)
}

/** Trimmed, at most 100 characters; blank or absent means no filter (null). */
const searchParam = z
  .string()
  .trim()
  .max(SEARCH_MAX_LENGTH)
  .optional()
  .transform((v) => (v ? v : null))

/**
 * Query schema shared by GET /api/products and GET /api/patients. Invalid values
 * are a 400 VALIDATION_ERROR naming the param (`q`, `offset` or `limit`).
 * Unknown params are ignored.
 */
export const listQuerySchema: z.ZodType<ParsedListQuery, ListQueryParams> =
  z.object({
    q: searchParam,
    offset: intParam(0, Number.MAX_SAFE_INTEGER, 0),
    limit: intParam(1, PAGE_LIMIT_MAX, PAGE_LIMIT_DEFAULT),
  })

export const listProductsQuerySchema = listQuerySchema

/** Patients list filter on each patient's most recent order (by created_at); `none` = no orders. */
export const LATEST_ORDER_STATUS_FILTERS = ['none', ...ORDER_STATUSES] as const
export type LatestOrderStatusFilter =
  (typeof LATEST_ORDER_STATUS_FILTERS)[number]

/** GET /api/patients: the shared list query plus an optional latest-status filter. */
export interface ListPatientsQuery extends ListQuery {
  latestStatus?: LatestOrderStatusFilter
}

export interface ParsedListPatientsQuery extends ParsedListQuery {
  latestStatus?: LatestOrderStatusFilter
}

export const listPatientsQuerySchema: z.ZodType<
  ParsedListPatientsQuery,
  ListQueryParams & { latestStatus?: unknown }
> = z.object({
  q: searchParam,
  offset: intParam(0, Number.MAX_SAFE_INTEGER, 0),
  limit: intParam(1, PAGE_LIMIT_MAX, PAGE_LIMIT_DEFAULT),
  latestStatus: z.enum(LATEST_ORDER_STATUS_FILTERS).optional(),
})

/** Provider order-list filter: one status, or `all`. */
export const ORDER_LIST_STATUS_FILTERS = [...ORDER_STATUSES, 'all'] as const
export type OrderListStatusFilter = (typeof ORDER_LIST_STATUS_FILTERS)[number]

/**
 * GET /api/orders.
 * - Without `status`: unchanged. A provider gets ProviderOrderSummaryDto[] (optionally
 *   one patient's); a patient gets their sent orders as PatientOrderSummaryDto[].
 * - With `status` (provider only; a patient gets 403): Page<ProviderOrderListItemDto>,
 *   honouring `offset`/`limit` and the optional `patientId`. `pending_payment` lists the
 *   oldest sentAt first; every other filter, `all` included, lists the most recent
 *   activity first (latest of paidAt, cancelledAt, sentAt, createdAt), then id desc.
 */
export interface ListOrdersQuery {
  patientId?: number
  status?: OrderListStatusFilter
  offset?: number
  limit?: number
}

export interface ParsedListOrdersQuery {
  patientId?: number
  status?: OrderListStatusFilter
  offset: number
  limit: number
}

export const listOrdersQuerySchema: z.ZodType<
  ParsedListOrdersQuery,
  ListQueryParams & { patientId?: unknown; status?: unknown }
> = z.object({
  patientId: idParamSchema.optional(),
  status: z.enum(ORDER_LIST_STATUS_FILTERS).optional(),
  offset: intParam(0, Number.MAX_SAFE_INTEGER, 0),
  limit: intParam(1, PAGE_LIMIT_MAX, PAGE_LIMIT_DEFAULT),
})

/** POST /api/orders creates an empty draft. */
export interface CreateOrderRequest {
  patientId: number
}

export const createOrderRequestSchema: z.ZodType<CreateOrderRequest> =
  z.strictObject({
    patientId: id,
  })

/**
 * One line as sent by the client. Drafts may be incomplete: `productId` and
 * `unitPriceCents` may be null or omitted, and `quantity` defaults to 1.
 */
export interface OrderLineInput {
  productId?: number | null
  quantity?: number
  /** Patient-facing price per unit, set by the provider. */
  unitPriceCents?: number | null
}

/** A line after parsing: every key present, incomplete parts as null. */
export interface DraftLine {
  productId: number | null
  quantity: number
  unitPriceCents: number | null
}

/**
 * PUT /api/orders/:id/lines replaces every line of a draft, preserving order.
 * Incomplete lines are stored and returned as-is. Saving still rejects
 * duplicate or unknown products and negative or non-integer values; the minimum
 * price and completeness are enforced only on send.
 * COGS is never accepted from the client: the server snapshots it from the product.
 */
export interface ReplaceOrderLinesRequest {
  lines: OrderLineInput[]
}

export interface ParsedReplaceOrderLinesRequest {
  lines: DraftLine[]
}

export const orderLineInputSchema: z.ZodType<DraftLine, OrderLineInput> =
  z.strictObject({
    productId: id.nullable().default(null),
    quantity: z.int().min(1).default(1),
    unitPriceCents: z.int().nonnegative().nullable().default(null),
  })

export const replaceOrderLinesRequestSchema: z.ZodType<
  ParsedReplaceOrderLinesRequest,
  ReplaceOrderLinesRequest
> = z.strictObject({
  lines: z.array(orderLineInputSchema),
})

/**
 * POST /api/orders/:id/pay. The body may be empty.
 * `simulateFailure` forces the fake gateway to decline; ignored when NODE_ENV is production.
 */
export interface PayOrderRequest {
  simulateFailure?: boolean
}

export const payOrderRequestSchema: z.ZodType<PayOrderRequest> = z.strictObject(
  {
    simulateFailure: z.boolean().optional(),
  },
)
