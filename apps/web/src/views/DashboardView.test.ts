import type { DashboardDto, ProductDto } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import DashboardView from './DashboardView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getDashboard: vi.fn(), searchProducts: vi.fn() }
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
  vi.mocked(api.searchProducts).mockResolvedValue({
    items: products,
    total: products.length,
    offset: 0,
    limit: 25,
  })
})

describe('DashboardView', () => {
  it('shows inventory read-only, with no inputs or Save buttons', async () => {
    await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(screen.getByRole('cell', { name: '119' })).toBeInTheDocument()
    // The only input is the search box; stock itself is never editable.
    expect(screen.getAllByRole('searchbox')).toHaveLength(1)
    expect(screen.getByRole('searchbox')).toHaveAccessibleName(
      'Search products',
    )
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /save/i }),
    ).not.toBeInTheDocument()
  })

  it('labels cost as wholesale cost, never COGS or our cost', async () => {
    await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(screen.getAllByText('Wholesale cost').length).toBeGreaterThan(0)
    expect(document.body).not.toHaveTextContent(/COGS|our cost/i)
    expect(document.body).not.toHaveTextContent(/Platform fee/i)
    expect(screen.getByText('Processing fees')).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Processing fee' }),
    ).toBeInTheDocument()
  })

  it('opens the order when a paid-order row is clicked', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView)

    await user.click(await screen.findByText('Jordan Lee'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/orders/7'),
    )
  })

  it('names each stat tile and table so they can be found by role', async () => {
    await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(
      within(screen.getByRole('group', { name: 'GMV' })).getByText('$69.51'),
    ).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('group', { name: 'Your margin earned' }),
      ).getByText('$34.99'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Processing fees' })).getByText(
        '$0.52',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('table', { name: 'Paid orders' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Inventory' })).toBeInTheDocument()
  })
})
