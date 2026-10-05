import { beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from './client'
import { listProducts, searchPatients } from './endpoints'

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

  it('collects every page for screens that still expect an array', async () => {
    const page = (offset: number, ids: number[]) => ({
      items: ids.map((id) => ({ id })),
      total: 3,
      offset,
      limit: 100,
    })
    vi.mocked(request)
      .mockResolvedValueOnce(page(0, [1, 2]))
      .mockResolvedValueOnce(page(2, [3]))

    const all = await listProducts()

    expect(all).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(vi.mocked(request).mock.calls.map((c) => c[1])).toEqual([
      '/products?offset=0&limit=100',
      '/products?offset=2&limit=100',
    ])
  })
})
