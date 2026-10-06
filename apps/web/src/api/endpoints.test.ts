import { beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from './client'
import { cancelOrder, listAwaitingPayment, searchPatients } from './endpoints'

vi.mock('./client', () => ({ request: vi.fn() }))

describe('list endpoints', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset()
  })

  it('builds the search query string', async () => {
    vi.mocked(request).mockResolvedValue({
      items: [],
      total: 0,
      offset: 25,
      limit: 25,
    })

    await searchPatients({ q: 'lee & co', offset: 25, limit: 25 })

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/patients?q=lee+%26+co&offset=25&limit=25',
    )
  })

  it('asks for one page of pending orders by status', async () => {
    vi.mocked(request).mockResolvedValue({
      items: [],
      total: 0,
      offset: 50,
      limit: 25,
    })

    await listAwaitingPayment({ offset: 50, limit: 25 })

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/orders?status=pending_payment&offset=50&limit=25',
    )
  })
})

describe('cancelOrder', () => {
  it('posts to the order cancel endpoint', async () => {
    await cancelOrder(12)

    expect(request).toHaveBeenCalledWith('POST', '/orders/12/cancel')
  })
})
