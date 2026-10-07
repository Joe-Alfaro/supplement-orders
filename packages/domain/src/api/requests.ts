import { z } from 'zod'
import {
  ORDER_STATUSES,
  type DashboardRangeDto,
  type OrderStatus,
} from './responses'

/** Every request except GET /api/users and GET /api/health carries this header. */
export const USER_ID_HEADER = 'X-User-Id'

/**
 * Ids are Postgres integer columns: anything above this cannot exist, and
 * passing it to a query is a database error. Revision 11 (N6) rejects it as a
 * 400 instead.
 */
export const POSTGRES_INTEGER_MAX = 2_147_483_647

const id = z.int().positive().max(POSTGRES_INTEGER_MAX)

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

/** One value of the provider order-list filter (kept for revision 8 callers). */
export type OrderListStatusFilter = OrderStatus | 'all'

/** A parsed status filter: a de-duplicated set of statuses, or `all`. */
export type OrderStatusSelection = OrderStatus[] | 'all'

/**
 * `status` as a comma-separated list (revision 8b): one or more of draft,
 * pending_payment, paid, cancelled, or exactly `all`. Duplicates are ignored and
 * the order of first appearance is kept. An empty string, an unknown value, an
 * empty item ("draft,") or `all` mixed with statuses is a 400 on `status`.
 */
const statusSelectionParam = z
  .string()
  .transform((raw, ctx): OrderStatusSelection => {
    if (raw === 'all') return 'all'
    const parts = raw.split(',')
    const invalid = parts.find(
      (part) => !(ORDER_STATUSES as readonly string[]).includes(part),
    )
    if (invalid !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          invalid === ''
            ? 'Status must list one or more of draft, pending_payment, paid, cancelled, or be all'
            : `Unknown status "${invalid}"`,
      })
      return z.NEVER
    }
    return [...new Set(parts as OrderStatus[])]
  })

/**
 * GET /api/orders.
 * - Without `status`: unchanged. A provider gets ProviderOrderSummaryDto[] (optionally
 *   one patient's); a patient gets their sent orders as PatientOrderSummaryDto[].
 * - With `status` (provider only; a patient gets 403): Page<ProviderOrderListItemDto>,
 *   honouring `offset`/`limit` and the optional `patientId`. Exactly
 *   `pending_payment` lists the oldest sentAt first; any other selection, `all`
 *   included, lists the most recent activity first (latest of paidAt, cancelledAt,
 *   sentAt, createdAt), then id desc.
 */
export interface ListOrdersQuery {
  patientId?: number
  /** `all`, one status, or several (sent comma-separated). */
  status?: 'all' | OrderStatus | readonly OrderStatus[]
  offset?: number
  limit?: number
}

export interface ParsedListOrdersQuery {
  patientId?: number
  status?: OrderStatusSelection
  offset: number
  limit: number
}

export const listOrdersQuerySchema: z.ZodType<
  ParsedListOrdersQuery,
  ListQueryParams & { patientId?: unknown; status?: unknown }
> = z.object({
  patientId: idParamSchema.optional(),
  status: statusSelectionParam.optional(),
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

/** Draft line bounds (revision 9), checked before anything is written. */
export const MAX_LINE_QUANTITY = 1000
/** $10,000 per unit. */
export const MAX_UNIT_PRICE_CENTS = 1_000_000

export const orderLineInputSchema: z.ZodType<DraftLine, OrderLineInput> =
  z.strictObject({
    productId: id.nullable().default(null),
    quantity: z.int().min(1).max(MAX_LINE_QUANTITY).default(1),
    unitPriceCents: z
      .int()
      .min(0)
      .max(MAX_UNIT_PRICE_CENTS)
      .nullable()
      .default(null),
  })

export const replaceOrderLinesRequestSchema: z.ZodType<
  ParsedReplaceOrderLinesRequest,
  ReplaceOrderLinesRequest
> = z.strictObject({
  lines: z.array(orderLineInputSchema),
})

/**
 * POST /api/orders/:id/pay (revision 9). The patient echoes the quote they saw;
 * if the order's revision or total has changed since, the server answers 409
 * ORDER_CHANGED and charges nothing. `simulateFailure` forces the fake gateway
 * to decline; ignored when NODE_ENV is production.
 */
export interface PayOrderRequest {
  /** The order's `revision` as shown to the patient. */
  expectedRevision: number
  /** The `totalCents` the patient saw and is consenting to pay. */
  expectedTotalCents: number
  simulateFailure?: boolean
}

export const payOrderRequestSchema: z.ZodType<PayOrderRequest> = z.strictObject(
  {
    expectedRevision: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    expectedTotalCents: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    simulateFailure: z.boolean().optional(),
  },
)

export const DASHBOARD_RANGE_PRESETS = [
  'month',
  'last30',
  'all',
  'custom',
] as const
export type DashboardRangePreset = (typeof DASHBOARD_RANGE_PRESETS)[number]

/** The most days a custom range may span, both ends inclusive. */
export const DASHBOARD_CUSTOM_MAX_DAYS = 366

/** Raw query-string values for GET /api/dashboard as Express delivers them. */
export interface DashboardQueryParams {
  range?: unknown
  from?: unknown
  to?: unknown
  tz?: unknown
}

/** A validated GET /api/dashboard query, before "today" is known. */
export interface DashboardQuery {
  preset: DashboardRangePreset
  /** Inclusive YYYY-MM-DD; set only for `custom`. */
  from: string | null
  /** Inclusive YYYY-MM-DD; set only for `custom`. */
  to: string | null
  /** IANA zone the days are read in. */
  timeZone: string
}

const MS_PER_DAY = 86_400_000

function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

function shiftDay(day: string, days: number): string {
  return new Date(dayToMs(day) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

/** A real calendar day as YYYY-MM-DD (revision 11a-v2). */
const dayParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a day as YYYY-MM-DD')
  .refine((raw) => {
    const ms = dayToMs(raw)
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(raw)
  }, 'Must be a real calendar day')

/**
 * An IANA zone name. The shape check keeps Intl-only forms (numeric offsets)
 * out, since the same name is later handed to Postgres.
 */
const timeZoneParam = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/,
    'Must be an IANA zone',
  )
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      return true
    } catch {
      return false
    }
  }, 'Unknown time zone, expected an IANA zone such as America/Chicago')

/** Today's calendar day (YYYY-MM-DD) in `timeZone`. */
export function calendarDayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`
}

/**
 * Query schema for GET /api/dashboard (revision 11a-v2). `range` defaults to
 * `month` and `tz` to UTC. `from` and `to` are inclusive days, required for
 * `custom` and rejected for every other preset; `from` <= `to` and the span is
 * at most 366 days.
 */
export const dashboardQuerySchema: z.ZodType<
  DashboardQuery,
  DashboardQueryParams
> = z
  .object({
    range: z.enum(DASHBOARD_RANGE_PRESETS).default('month'),
    from: dayParam.optional(),
    to: dayParam.optional(),
    tz: timeZoneParam.default('UTC'),
  })
  .superRefine(({ range, from, to }, ctx) => {
    const given = { from, to }
    const keys = ['from', 'to'] as const
    if (range !== 'custom') {
      keys
        .filter((key) => given[key] !== undefined)
        .forEach((key) =>
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `\`${key}\` is only allowed with range=custom`,
          }),
        )
      return
    }
    if (from === undefined || to === undefined) {
      keys
        .filter((key) => given[key] === undefined)
        .forEach((key) =>
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `\`${key}\` is required with range=custom`,
          }),
        )
      return
    }
    const span = (dayToMs(to) - dayToMs(from)) / MS_PER_DAY + 1
    if (span < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: '`to` must be on or after `from`',
      })
    } else if (span > DASHBOARD_CUSTOM_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `The range may span at most ${DASHBOARD_CUSTOM_MAX_DAYS} days`,
      })
    }
  })
  .transform(({ range, from, to, tz }) => ({
    preset: range,
    from: from ?? null,
    to: to ?? null,
    timeZone: tz,
  }))

/**
 * Turns a validated query into the days it covers, given today's day in the
 * query's zone: `month` is the 1st through today, `last30` is today minus 29
 * days through today, `all` has no days, `custom` echoes its own.
 */
export function resolveDashboardRange(
  query: DashboardQuery,
  today: string,
): DashboardRangeDto {
  const { preset, timeZone } = query
  if (preset === 'all') return { preset, from: null, to: null, timeZone }
  if (preset === 'month') {
    return { preset, from: `${today.slice(0, 8)}01`, to: today, timeZone }
  }
  if (preset === 'last30') {
    return { preset, from: shiftDay(today, -29), to: today, timeZone }
  }
  return { preset, from: query.from, to: query.to, timeZone }
}
