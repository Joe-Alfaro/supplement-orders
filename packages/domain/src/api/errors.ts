import { z } from 'zod'
import {
  partialPaymentQuoteDtoSchema,
  type PartialPaymentQuoteDto,
} from './responses'

/**
 * Every non-2xx response body is `{ error: { code, message, field? } }`.
 *
 * Status mapping:
 * - 400 VALIDATION_ERROR: request body, params, or query failed schema validation
 * - 401 UNAUTHENTICATED: missing or unknown X-User-Id
 * - 403 FORBIDDEN: wrong persona, or the resource belongs to someone else
 * - 404 NOT_FOUND: the resource does not exist
 * - 409 ORDER_NOT_DRAFT / ORDER_NOT_PAYABLE / ORDER_NOT_CANCELLABLE / ORDER_NOT_REOPENABLE:
 *   the order is in the wrong status. Edit, send and DELETE need a draft; cancel needs
 *   pending_payment (revision 8: drafts are deleted instead); reopen needs cancelled.
 * - 422 split codes, INCOMPLETE_LINE, DUPLICATE_PRODUCT, UNKNOWN_PRODUCT:
 *   business rule failed. INCOMPLETE_LINE (send only) names the missing part,
 *   e.g. `lines.1.productId` or `lines.0.unitPriceCents`. EMPTY_ORDER has no field.
 * - 409 ORDER_CHANGED: pay's expectedRevision/expectedTotalCents no longer match the order.
 *   With `mode: 'available'` the body carries the fresh `partialPaymentQuote` (revision 14).
 * - 409 INSUFFICIENT_STOCK (revision 14): a `full` pay found a line short of stock; the
 *   body carries `availability` per line and the current `partialPaymentQuote`. Nothing was charged.
 * - 409 AWAITING_STOCK (revision 14): an `available` pay found nothing in stock to pay for.
 * - 409 LOW_STOCK_UNACKNOWLEDGED (revision 14): send found lines above available stock
 *   without `acknowledgeLowStock: true`; the body lists them in `lines`.
 * - 409 BACKORDER_NOT_EDITABLE (revision 14): a back-order can never be reopened as a draft.
 * - 409 PAYMENT_NEEDS_RECONCILIATION: a charge succeeded but its payment was not recorded;
 *   cancel, reopen, delete and line edits are blocked until a retried pay completes it
 * - 409 IDEMPOTENCY_KEY_REUSED: the gateway refused a known key with a different amount
 * - 409 STOCK_CHANGED (revision 13): an admin's stock set expected a value that is no
 *   longer current; the body carries `currentStockQuantity`
 * - 402 PAYMENT_FAILED: the gateway declined; nothing was persisted
 * - 413 PAYLOAD_TOO_LARGE: the request body exceeds the server's limit
 * - other client errors from reading the body (e.g. 415 for an unsupported charset)
 *   keep their 4xx status with VALIDATION_ERROR
 * - 500 INTERNAL: unexpected failure; nothing was persisted
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ORDER_NOT_DRAFT',
  'ORDER_NOT_PAYABLE',
  'ORDER_NOT_CANCELLABLE',
  'ORDER_NOT_REOPENABLE',
  'ORDER_CHANGED',
  'PAYMENT_NEEDS_RECONCILIATION',
  'IDEMPOTENCY_KEY_REUSED',
  'STOCK_CHANGED',
  'AWAITING_STOCK',
  'LOW_STOCK_UNACKNOWLEDGED',
  'BACKORDER_NOT_EDITABLE',
  'EMPTY_ORDER',
  'INVALID_QUANTITY',
  'INVALID_AMOUNT',
  'PRICE_BELOW_MINIMUM',
  'INCOMPLETE_LINE',
  'UNSAFE_AMOUNT',
  'DUPLICATE_PRODUCT',
  'UNKNOWN_PRODUCT',
  'INSUFFICIENT_STOCK',
  'PAYMENT_FAILED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/**
 * INSUFFICIENT_STOCK (revision 14): one entry per line of the order, with the
 * product's available stock now (raw, uncapped).
 */
export interface StockAvailabilityDto {
  lineId: number
  productId: number
  quantity: number
  availableQuantity: number
}

/** LOW_STOCK_UNACKNOWLEDGED (revision 14): a line whose quantity exceeds available stock. */
export interface LowStockLineDto {
  lineId: number
  productId: number
  productName: string
  quantity: number
  availableQuantity: number
}

const stockAvailabilityDtoSchema: z.ZodType<StockAvailabilityDto> = z.object({
  lineId: z.int().positive(),
  productId: z.int().positive(),
  quantity: z.int().min(1),
  availableQuantity: z.int().nonnegative(),
})

const lowStockLineDtoSchema: z.ZodType<LowStockLineDto> = z.object({
  lineId: z.int().positive(),
  productId: z.int().positive(),
  productName: z.string(),
  quantity: z.int().min(1),
  availableQuantity: z.int().nonnegative(),
})

export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  /**
   * Dotted path of the offending input, matching the request body shape,
   * e.g. `lines.1.unitPriceCents` or `stockQuantity`. Absent for non-field errors.
   */
  field?: string
  /** STOCK_CHANGED only: the product's stock now, to show the admin. */
  currentStockQuantity?: number
  /** INSUFFICIENT_STOCK only. */
  availability?: StockAvailabilityDto[]
  /** INSUFFICIENT_STOCK, and ORDER_CHANGED from an `available` pay: the quote now (no fee). */
  partialPaymentQuote?: PartialPaymentQuoteDto
  /** LOW_STOCK_UNACKNOWLEDGED only. */
  lines?: LowStockLineDto[]
}

export interface ApiErrorResponse {
  error: ApiErrorBody
}

export interface StockChangedErrorResponse {
  error: {
    code: 'STOCK_CHANGED'
    message: string
    currentStockQuantity: number
  }
}

export const stockChangedErrorResponseSchema: z.ZodType<StockChangedErrorResponse> =
  z.object({
    error: z.object({
      code: z.literal('STOCK_CHANGED'),
      message: z.string(),
      currentStockQuantity: z.int().nonnegative(),
    }),
  })

export interface InsufficientStockErrorResponse {
  error: {
    code: 'INSUFFICIENT_STOCK'
    message: string
    availability: StockAvailabilityDto[]
    partialPaymentQuote: PartialPaymentQuoteDto
  }
}

export const insufficientStockErrorResponseSchema: z.ZodType<InsufficientStockErrorResponse> =
  z.object({
    error: z.object({
      code: z.literal('INSUFFICIENT_STOCK'),
      message: z.string(),
      availability: z.array(stockAvailabilityDtoSchema),
      partialPaymentQuote: partialPaymentQuoteDtoSchema,
    }),
  })

export interface LowStockUnacknowledgedErrorResponse {
  error: {
    code: 'LOW_STOCK_UNACKNOWLEDGED'
    message: string
    lines: LowStockLineDto[]
  }
}

export const lowStockUnacknowledgedErrorResponseSchema: z.ZodType<LowStockUnacknowledgedErrorResponse> =
  z.object({
    error: z.object({
      code: z.literal('LOW_STOCK_UNACKNOWLEDGED'),
      message: z.string(),
      lines: z.array(lowStockLineDtoSchema),
    }),
  })

export const apiErrorResponseSchema: z.ZodType<ApiErrorResponse> = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    field: z.string().optional(),
    currentStockQuantity: z.int().nonnegative().optional(),
    availability: z.array(stockAvailabilityDtoSchema).optional(),
    partialPaymentQuote: partialPaymentQuoteDtoSchema.optional(),
    lines: z.array(lowStockLineDtoSchema).optional(),
  }),
})
