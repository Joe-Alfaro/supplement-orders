import {
  apiErrorResponseSchema,
  USER_ID_HEADER,
  type ApiErrorCode,
} from '@supplement-orders/domain'
import { readStoredUserId } from '../user/storage'

/** A non-2xx response, carrying the server's `{ error: { code, message, field? } }`. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'NETWORK',
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

async function toError(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  const parsed = apiErrorResponseSchema.safeParse(body)
  if (!parsed.success) {
    return new ApiRequestError(
      response.status,
      'INTERNAL',
      `Request failed (${response.status})`,
    )
  }
  const { code, message, field } = parsed.data.error
  return new ApiRequestError(response.status, code, message, field)
}

/** The only place the app calls fetch. Sends the selected user as X-User-Id. */
export async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const userId = readStoredUserId()
  if (userId !== null) headers[USER_ID_HEADER] = String(userId)
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new ApiRequestError(0, 'NETWORK', 'Could not reach the server')
  })
  if (!response.ok) throw await toError(response)
  return (await response.json()) as T
}

export function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}
