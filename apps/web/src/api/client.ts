import {
  apiErrorResponseSchema,
  USER_ID_HEADER,
  type ApiErrorBody,
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
    /** Set on 409 STOCK_CHANGED: the stock the server holds now. */
    readonly currentStockQuantity?: number,
    /** The rest of the error body, e.g. `lines` on 409 LOW_STOCK_UNACKNOWLEDGED. */
    readonly details?: Partial<ApiErrorBody>,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function toError(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  const parsed = apiErrorResponseSchema.safeParse(body)
  const raw = isRecord(body) && isRecord(body.error) ? body.error : null
  if (!parsed.success && !raw) {
    return new ApiRequestError(
      response.status,
      'INTERNAL',
      `Request failed (${response.status})`,
    )
  }
  // The strict schema drops extra body fields (and rejects codes it does not
  // know), so revision 14 reads the raw body for those.
  const known = parsed.success ? parsed.data.error : null
  const code = known?.code ?? raw?.code
  const message = known?.message ?? raw?.message
  if (typeof code !== 'string' || typeof message !== 'string') {
    return new ApiRequestError(
      response.status,
      'INTERNAL',
      `Request failed (${response.status})`,
    )
  }
  return new ApiRequestError(
    response.status,
    code as ApiRequestError['code'],
    message,
    known?.field,
    known?.currentStockQuantity,
    (raw ?? undefined) as Partial<ApiErrorBody> | undefined,
  )
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
  // e.g. DELETE: there is no body to parse; callers type T as void.
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const unauthenticatedListeners = new Set<() => void>()

/** Subscribe to "the server no longer recognizes this user" (any 401). */
export function onUnauthenticated(listener: () => void) {
  unauthenticatedListeners.add(listener)
  return () => {
    unauthenticatedListeners.delete(listener)
  }
}

function isUnauthenticated(err: unknown) {
  return (
    err instanceof ApiRequestError &&
    (err.status === 401 || err.code === 'UNAUTHENTICATED')
  )
}

/**
 * The single place request failures are handled: a 401 from any endpoint ends
 * the session (listeners sign out and return to /login). Returns the message
 * for the screen's error banner.
 */
export function handleApiError(err: unknown) {
  if (isUnauthenticated(err)) {
    unauthenticatedListeners.forEach((listener) => listener())
  }
  return errorMessage(err)
}

export function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}
