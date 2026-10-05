import { idParamSchema } from '@supplement-orders/domain'
import type { z } from 'zod'
import { ApiError } from './errors'

/** Parses input or throws 400 VALIDATION_ERROR naming the first offending field. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const field = issue?.path.map(String).join('.')
  throw new ApiError(
    400,
    'VALIDATION_ERROR',
    issue?.message ?? 'Invalid request',
    field ? field : undefined,
  )
}

export function parseId(value: unknown, field = 'id') {
  const result = idParamSchema.safeParse(value)
  if (result.success) return result.data
  throw new ApiError(
    400,
    'VALIDATION_ERROR',
    `${field} must be a positive integer`,
    field,
  )
}
