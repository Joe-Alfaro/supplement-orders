import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError, handleApiError, onUnauthenticated } from './client'

describe('handleApiError', () => {
  it('ends the session on a 401 from any endpoint and returns the message', () => {
    const listener = vi.fn()
    const unsubscribe = onUnauthenticated(listener)

    expect(
      handleApiError(
        new ApiRequestError(401, 'UNAUTHENTICATED', 'Unknown user'),
      ),
    ).toBe('Unknown user')
    expect(listener).toHaveBeenCalledTimes(1)

    expect(
      handleApiError(new ApiRequestError(422, 'EMPTY_ORDER', 'No lines')),
    ).toBe('No lines')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })
})
