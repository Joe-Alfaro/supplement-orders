import type { DashboardDto, ProductDto, ProductPageDto } from '@supplement-orders/domain'
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

function product(id: number, name: string): ProductDto {
  return {
    id,
    sku: `SKU-${id}`,
    name,
    cogsCents: 850,
    stockQuantity: 119,
  }
}

function productPage(
  items: ProductDto[],
  total = items.length,
  offset = 0,
): ProductPageDto {
  return { items, total, offset, limit: 25 }
}

const firstPage = Array.from({ length: 25 }, (_, index) =>
  product(index + 1, index === 0 ? 'Vitamin D3' : `Product ${index + 1}`),
)

// Answers like the server: page 2 of 30 when asked for offset 25.
function serveProducts(query: { offset?: number } = {}) {
  if (query.offset === 25) {
    return Promise.resolve(productPage([product(26, 'Zinc')], 30, 25))
  }
  return Promise.resolve(productPage(firstPage, 30))
}

beforeEach(() => {
  vi.mocked(api.getDashboard).mockReset().mockResolvedValue(dashboard)
  vi.mocked(api.searchProducts)
    .mockReset()
    .mockResolvedValue(productPage([product(1, 'Vitamin D3')]))
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
    // Revision 8 removed the explanatory note under the table.
    expect(
      screen.queryByText(/Stock decreases automatically/),
    ).not.toBeInTheDocument()
  })

  it('labels cost as wholesale cost, never COGS or our cost', async () => {
    await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(
      screen.getByRole('columnheader', { name: 'Wholesale cost' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/COGS|our cost/i)
    expect(document.body).not.toHaveTextContent(/Platform fee/i)
    expect(screen.getByText('Processing fees')).toBeInTheDocument()
  })

  it('names each stat tile so it can be found by role', async () => {
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
    expect(screen.getByRole('table', { name: 'Inventory' })).toBeInTheDocument()
  })

  it('keeps only Sales and Inventory: the order tables moved to Orders', async () => {
    await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')
    await screen.findByText('$69.51')

    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Sales', 'Inventory'])
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(
      screen.queryByRole('table', { name: 'Paid orders' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('table', { name: 'Awaiting payment' }),
    ).not.toBeInTheDocument()
    // The paid order's patient was only ever shown in the paid-orders table.
    expect(screen.queryByText('Jordan Lee')).not.toBeInTheDocument()
  })

  it('links to the Orders tab filtered to paid and to awaiting payment', async () => {
    await renderWithRouter(DashboardView)
    const sales = await screen.findByRole('region', { name: 'Sales' })

    expect(
      within(sales).getByRole('link', { name: 'See paid orders →' }),
    ).toHaveAttribute('href', '/orders?status=paid')
    expect(
      within(sales).getByRole('link', {
        name: 'See orders awaiting payment →',
      }),
    ).toHaveAttribute('href', '/orders?status=pending_payment')
  })
})

describe('DashboardView inventory URL state', () => {
  it('restores search and page from the URL', async () => {
    vi.mocked(api.searchProducts).mockImplementation(serveProducts)
    await renderWithRouter(DashboardView, { path: '/dashboard?q=vit&page=2' })

    expect(await screen.findByText('Zinc')).toBeInTheDocument()
    expect(api.searchProducts).toHaveBeenCalledWith({
      q: 'vit',
      offset: 25,
      limit: 25,
    })
    expect(
      screen.getByRole('searchbox', { name: 'Search products' }),
    ).toHaveValue('vit')
    expect(screen.getByText('Showing 26–26 of 30')).toBeInTheDocument()
  })

  it('replaces the URL while typing, omitting page 1', async () => {
    const user = userEvent.setup()
    vi.mocked(api.searchProducts).mockImplementation(serveProducts)
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard?page=2',
    })
    await screen.findByText('Zinc')
    const push = vi.spyOn(router, 'push')

    await user.type(
      screen.getByRole('searchbox', { name: 'Search products' }),
      'Vitamin',
    )

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/dashboard?q=Vitamin'),
    )
    expect(api.searchProducts).toHaveBeenLastCalledWith({
      q: 'Vitamin',
      offset: 0,
      limit: 25,
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('pushes page changes, and Back restores the previous page', async () => {
    const user = userEvent.setup()
    vi.mocked(api.searchProducts).mockImplementation(serveProducts)
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard?q=vit',
    })
    await screen.findByText('Vitamin D3')

    await user.click(screen.getByRole('button', { name: 'Next Page' }))

    expect(await screen.findByText('Zinc')).toBeInTheDocument()
    expect(router.currentRoute.value.fullPath).toBe('/dashboard?q=vit&page=2')
    expect(api.searchProducts).toHaveBeenLastCalledWith({
      q: 'vit',
      offset: 25,
      limit: 25,
    })

    router.back()

    expect(await screen.findByText('Vitamin D3')).toBeInTheDocument()
    expect(router.currentRoute.value.fullPath).toBe('/dashboard?q=vit')
    expect(api.searchProducts).toHaveBeenLastCalledWith({
      q: 'vit',
      offset: 0,
      limit: 25,
    })
    expect(screen.queryByText('Zinc')).not.toBeInTheDocument()
  })

  it('ignores a page that is not a positive whole number', async () => {
    await renderWithRouter(DashboardView, { path: '/dashboard?page=abc' })
    await screen.findByText('Vitamin D3')

    expect(api.searchProducts).toHaveBeenCalledWith({
      q: '',
      offset: 0,
      limit: 25,
    })
  })

  it('does not refetch inventory when leaving for another route', async () => {
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard?q=vit',
    })
    await screen.findByText('Vitamin D3')

    await router.push('/orders?status=paid')

    expect(api.searchProducts).toHaveBeenCalledTimes(1)
  })
})
