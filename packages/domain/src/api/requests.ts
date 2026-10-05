import { z } from 'zod'

/** Every request except GET /api/users and GET /api/health carries this header. */
export const USER_ID_HEADER = 'X-User-Id'

const id = z.int().positive()

/** Route params such as `:id` and `:patientId` arrive as strings. */
export const idParamSchema = z.coerce.number().pipe(id)

/** PATCH /api/products/:id/stock */
export interface UpdateStockRequest {
  stockQuantity: number
}

export const updateStockRequestSchema: z.ZodType<UpdateStockRequest> =
  z.strictObject({
    stockQuantity: z.int().nonnegative(),
  })

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

export interface OrderLineInput {
  productId: number
  quantity: number
  /** Patient-facing price per unit, set by the provider. */
  unitPriceCents: number
}

/**
 * PUT /api/orders/:id/lines replaces every line of a draft.
 * An empty list is allowed for a draft; sending requires at least one line.
 * COGS is never accepted from the client: the server snapshots it from the product.
 */
export interface ReplaceOrderLinesRequest {
  lines: OrderLineInput[]
}

export const orderLineInputSchema: z.ZodType<OrderLineInput> = z.strictObject({
  productId: id,
  quantity: z.int().min(1),
  unitPriceCents: z.int().nonnegative(),
})

export const replaceOrderLinesRequestSchema: z.ZodType<ReplaceOrderLinesRequest> =
  z.strictObject({
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
