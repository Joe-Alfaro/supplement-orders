import type { DashboardDto, ProductDto } from '@supplement-orders/domain'
import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import DashboardView from './DashboardView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getDashboard: vi.fn(), listProducts: vi.fn() }
})

const dashboard: DashboardDto = {
  gmvCents: 6951,
  providerMarginCents: 3499,
  platformFeeCents: 52,
  paidOrders: [
    {
      orderId: 7,
      patientId: 1,
      patientName: 'Jordan Lee',
      paidAt: '2026-10-05T12:00:00.000Z',
      totalCents: 6951,
      cogsCents: 3400,
      providerMarginCents: 3499,
      platformFeeCents: 52,
    },
  ],
}

const products: ProductDto[] = [
  {
    id: 1,
    sku: 'VITD',
    name: 'Vitamin D3',
    cogsCents: 850,
    stockQuantity: 119,
  },
]

beforeEach(() => {
  vi.mocked(api.getDashboard).mockResolvedValue(dashboard)
  vi.mocked(api.listProducts).mockResolvedValue(products)
})

describe('DashboardView', () => {
  it('shows inventory read-only, with no inputs or Save buttons', async () => {
    const { container } = await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(screen.getByText('119')).toBeTruthy()
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(
      0,
    )
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
  })

  it('labels cost as wholesale cost, never COGS or our cost', async () => {
    const { container } = await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(screen.getAllByText('Wholesale cost').length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(/COGS|our cost/i)
  })

  it('opens the order when a paid-order row is clicked', async () => {
    const { router } = await renderWithRouter(DashboardView)

    await fireEvent.click(await screen.findByText('Jordan Lee'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/orders/7'),
    )
  })
})
