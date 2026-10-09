import type { DashboardDto, Page } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { ProviderProductDto } from '../api'

import { renderWithRouter } from '../test/renderWithRouter'
import DashboardView from './DashboardView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getDashboard: vi.fn(), searchProducts: vi.fn() }
})

const empty: Page<ProviderProductDto> = {
  items: [],
  total: 0,
  offset: 0,
  limit: 25,
}

const dashboard: DashboardDto = {
  owedToYouCents: 0,
  gmvCents: 9000,
  providerMarginCents: 3000,
  platformFeeCents: 70,
  range: {
    preset: 'month',
    from: '2026-10-01',
    to: '2026-10-07',
    timeZone: 'UTC',
  },
  soldByProduct: [
    { productId: 2, productName: 'Omega-3', unitsSold: 5, revenueCents: 6000 },
    {
      productId: 1,
      productName: 'Vitamin D3',
      unitsSold: 3,
      revenueCents: 3000,
    },
  ],
}

beforeEach(() => {
  vi.mocked(api.getDashboard).mockReset().mockResolvedValue(dashboard)
  vi.mocked(api.searchProducts).mockReset().mockResolvedValue(empty)
})

describe('DashboardView Sold by product (18.3)', () => {
  it('lists product, units and revenue in the order the server sorted', async () => {
    await renderWithRouter(DashboardView)
    const table = await screen.findByRole('table', { name: 'Sold by product' })

    ;['Product', 'Units sold', 'Revenue'].forEach((name) =>
      expect(
        within(table).getByRole('columnheader', { name }),
      ).toBeInTheDocument(),
    )
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Omega-3')
    expect(rows[0]).toHaveTextContent('5')
    expect(rows[0]).toHaveTextContent('$60.00')
    expect(rows[1]).toHaveTextContent('Vitamin D3')
  })

  it('shows an empty state for the range', async () => {
    vi.mocked(api.getDashboard).mockResolvedValue({
      ...dashboard,
      soldByProduct: [],
    })
    await renderWithRouter(DashboardView)

    expect(
      await screen.findByText('No products sold in this range.'),
    ).toBeVisible()
    expect(screen.queryByRole('table', { name: 'Sold by product' })).toBeNull()
  })
})
