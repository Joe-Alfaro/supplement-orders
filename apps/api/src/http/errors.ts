import type {
  ApiErrorBody,
  ApiErrorCode,
  ApiErrorResponse,
} from '@supplement-orders/domain'
import type { ErrorRequestHandler } from 'express'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly field?: string,
    /** Extra error-body fields some codes carry, e.g. STOCK_CHANGED. */
    readonly details: Pick<
      ApiErrorBody,
      | 'currentStockQuantity'
      | 'availability'
      | 'partialPaymentQuote'
      | 'lines'
      | 'priorOrderId'
    > = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toBody(): ApiErrorResponse {
    const { code, message, field, details } = this
    const base =
      field === undefined ? { code, message } : { code, message, field }
    return { error: { ...base, ...details } }
  }
}

export function notFound(what: string) {
  return new ApiError(404, 'NOT_FOUND', `${what} not found`)
}

export function forbidden(message = 'You do not have access to this resource') {
  return new ApiError(403, 'FORBIDDEN', message)
}

/** The fields of an http-errors error, as raised by express.json() (body-parser). */
interface ClientHttpError {
  status: number
  expose: boolean
  type?: string
}

/**
 * True for errors body-parser raises about the client's request (exposed, with
 * a 4xx status). Anything else is ours and stays a generic 500.
 */
function isClientHttpError(err: unknown): err is ClientHttpError {
  if (typeof err !== 'object' || err === null) return false
  const { status, expose } = err as Partial<ClientHttpError>
  return (
    expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  )
}

/**
 * Revision 11 (N6): request-body problems are the caller's, so they keep their
 * 4xx status in the standard error shape with a fixed, safe message.
 */
function clientErrorFor(err: ClientHttpError): ApiError {
  if (err.status === 413 || err.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
  }
  if (err.type === 'entity.parse.failed') {
    return new ApiError(400, 'VALIDATION_ERROR', 'Malformed JSON body')
  }
  return new ApiError(
    err.status,
    'VALIDATION_ERROR',
    'The request body could not be read',
  )
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err)
    return
  }
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toBody())
    return
  }
  // express.json() raises exposed 4xx errors: malformed JSON, too large, bad charset.
  if (isClientHttpError(err)) {
    const apiError = clientErrorFor(err)
    res.status(apiError.status).json(apiError.toBody())
    return
  }
  console.error(err)
  res
    .status(500)
    .json(new ApiError(500, 'INTERNAL', 'Internal server error').toBody())
}
