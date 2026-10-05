import { z } from 'zod'

/** Every request except GET /api/users and GET /api/health carries this header. */
export const USER_ID_HEADER = 'X-User-Id'

const id = z.int().positive()

/** Route params such as `:id` and `:patientId` arrive as strings. */
export const idParamSchema = z.coerce.number().pipe(id)

/** GET /api/orders?patientId= */
export interface ListOrdersQuery {
  patientId?: number
}

export const listOrdersQuerySchema: z.ZodType<ListOrdersQuery> = z.object({
  patientId: idParamSchema.optional(),
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
