import type { ApiErrorCode, ApiErrorResponse } from '@supplement-orders/domain'
import type { ErrorRequestHandler } from 'express'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toBody(): ApiErrorResponse {
    const { code, message, field } = this
    return {
      error: field === undefined ? { code, message } : { code, message, field },
    }
  }
}

export function notFound(what: string) {
  return new ApiError(404, 'NOT_FOUND', `${what} not found`)
}

export function forbidden(message = 'You do not have access to this resource') {
  return new ApiError(403, 'FORBIDDEN', message)
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
  // express.json() rejects malformed JSON with a 400 SyntaxError
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res
      .status(400)
      .json(
        new ApiError(400, 'VALIDATION_ERROR', 'Malformed JSON body').toBody(),
      )
    return
  }
  console.error(err)
  res
    .status(500)
    .json(new ApiError(500, 'INTERNAL', 'Internal server error').toBody())
}
