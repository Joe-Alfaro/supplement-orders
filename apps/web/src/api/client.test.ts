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

  it('keeps currentStockQuantity from a 409 STOCK_CHANGED', async () => {
    const body = {
      error: {
        code: 'STOCK_CHANGED',
        message: 'Changed',
        currentStockQuantity: 12,
      },
    }
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
  })
})

describe('request with revision 14 error codes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the whole error body as details, even for codes the domain does not know yet', async () => {
    const body = {
      error: {
        code: 'LOW_STOCK_UNACKNOWLEDGED',
        message: 'Low stock',
        lines: [
          {
            lineId: 1,
            productId: 2,
            productName: 'Zinc',
            quantity: 5,
            availableQuantity: 3,
          },
        ],
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })),
    )

    await expect(request('POST', '/orders/1/send', {})).rejects.toMatchObject({
      status: 409,
      code: 'LOW_STOCK_UNACKNOWLEDGED',
      message: 'Low stock',
      details: { lines: body.error.lines },
    })
  })
})
