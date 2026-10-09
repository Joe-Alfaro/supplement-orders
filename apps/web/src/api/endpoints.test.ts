import { beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from './client'
import {
  cancelOrder,
  deleteOrder,
  getDashboard,
  incrementProductStock,
  reopenOrder,
  resetDefaultPrice,
  searchAdminProducts,
  searchPatients,
  setDefaultPrice,
  setProductStock,
} from './endpoints'

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
})

describe('cancelOrder', () => {
  it('posts to the order cancel endpoint', async () => {
    await cancelOrder(12)

    expect(request).toHaveBeenCalledWith('POST', '/orders/12/cancel')
  })
})

describe('deleteOrder', () => {
  it('sends DELETE to the order', async () => {
    await deleteOrder(12)

    expect(request).toHaveBeenCalledWith('DELETE', '/orders/12')
  })
})

describe('reopenOrder', () => {
  it('posts to the order reopen endpoint', async () => {
    await reopenOrder(12)

    expect(request).toHaveBeenCalledWith('POST', '/orders/12/reopen')
  })
})

describe('getDashboard', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset()
  })

  it('sends nothing for the default', async () => {
    await getDashboard()

    expect(request).toHaveBeenCalledWith('GET', '/dashboard')
  })

  it('forwards the preset and zone untouched', async () => {
    await getDashboard({ range: 'last30', tz: 'America/Chicago' })

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/dashboard?range=last30&tz=America%2FChicago',
    )
  })

  it('forwards custom days as written', async () => {
    await getDashboard({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-07',
      tz: 'UTC',
    })

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/dashboard?range=custom&from=2026-10-01&to=2026-10-07&tz=UTC',
    )
  })
})

describe('admin inventory endpoints', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset()
  })

  it('searches the admin catalog', async () => {
    await searchAdminProducts({ q: 'vit', offset: 25, limit: 25 })

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/admin/products?q=vit&offset=25&limit=25',
    )
  })

  it('sets and resets a default price', async () => {
    await setDefaultPrice(3, 2000)
    await resetDefaultPrice(3)

    expect(request).toHaveBeenCalledWith('PUT', '/products/3/default-price', {
      unitPriceCents: 2000,
    })
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/products/3/default-price/reset',
    )
  })

  it('increments stock by an amount', async () => {
    await incrementProductStock(3, 10)

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/admin/products/3/stock/increment',
      { by: 10 },
    )
  })

  it('sets stock with the expected value', async () => {
    await setProductStock(3, { stockQuantity: 5, expectedStockQuantity: 9 })

    expect(request).toHaveBeenCalledWith('PUT', '/admin/products/3/stock', {
      stockQuantity: 5,
      expectedStockQuantity: 9,
    })
  })
})
