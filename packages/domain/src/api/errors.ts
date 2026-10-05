import { z } from 'zod'

/**
 * Every non-2xx response body is `{ error: { code, message, field? } }`.
 *
 * Status mapping:
 * - 400 VALIDATION_ERROR: request body, params, or query failed schema validation
 * - 401 UNAUTHENTICATED: missing or unknown X-User-Id
 * - 403 FORBIDDEN: wrong persona, or the resource belongs to someone else
 * - 404 NOT_FOUND: the resource does not exist
 * - 409 ORDER_NOT_DRAFT / ORDER_NOT_PAYABLE: the order is in the wrong status
 * - 422 split codes, INCOMPLETE_LINE, DUPLICATE_PRODUCT, UNKNOWN_PRODUCT, INSUFFICIENT_STOCK:
 *   business rule failed. INCOMPLETE_LINE (send only) names the missing part,
 *   e.g. `lines.1.productId` or `lines.0.unitPriceCents`. EMPTY_ORDER has no field.
 * - 402 PAYMENT_FAILED: the gateway declined; nothing was persisted
 * - 500 INTERNAL: unexpected failure; nothing was persisted
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ORDER_NOT_DRAFT',
  'ORDER_NOT_PAYABLE',
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
  'INTERNAL',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  /**
   * Dotted path of the offending input, matching the request body shape,
   * e.g. `lines.1.unitPriceCents` or `stockQuantity`. Absent for non-field errors.
   */
  field?: string
}

export interface ApiErrorResponse {
  error: ApiErrorBody
}

export const apiErrorResponseSchema: z.ZodType<ApiErrorResponse> = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    field: z.string().optional(),
  }),
})
