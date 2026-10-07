import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  handleApiError,
  onUnauthenticated,
  request,
} from './client'

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

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves to undefined on 204 No Content instead of parsing a body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(request('DELETE', '/orders/12')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orders/12',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it.each([
    [
      'inside error',
      {
        error: {
          code: 'STOCK_CHANGED',
          message: 'Changed',
          currentStockQuantity: 12,
        },
      },
    ],
    [
      'beside error',
      {
        error: { code: 'STOCK_CHANGED', message: 'Changed' },
        currentStockQuantity: 12,
      },
    ],
  ])(
    'keeps currentStockQuantity from a 409 STOCK_CHANGED (%s)',
    async (_label, body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })),
      )

      await expect(
        request('PUT', '/admin/products/1/stock', {}),
      ).rejects.toMatchObject({
        status: 409,
        code: 'STOCK_CHANGED',
        message: 'Changed',
        currentStockQuantity: 12,
      })
    },
  )
})
