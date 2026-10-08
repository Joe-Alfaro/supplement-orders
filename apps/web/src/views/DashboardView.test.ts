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
  owedToYouCents: 0,
  range: {
    preset: 'month',
    from: '2026-10-01',
    to: '2026-10-07',
    timeZone: 'UTC',
  },
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

/** What the server resolved for a preset, so the label can be rendered. */
function resolved(
  preset: DashboardDto['range']['preset'],
  from: string | null,
  to: string | null,
): DashboardDto {
  return {
    ...dashboard,
    range: { preset, from, to, timeZone: tz },
  }
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

describe('DashboardView date range', () => {
  const lastRequest = () => vi.mocked(api.getDashboard).mock.lastCall?.[0]

  beforeEach(() => {
    vi.mocked(api.getDashboard).mockImplementation((params = {}) => {
      if (params.range === 'last30') {
        return Promise.resolve(resolved('last30', '2026-09-08', '2026-10-07'))
      }
      if (params.range === 'all') {
        return Promise.resolve(resolved('all', null, null))
      }
      if (params.range === 'custom') {
        return Promise.resolve(
          resolved('custom', params.from ?? null, params.to ?? null),
        )
      }
      return Promise.resolve(dashboard)
    })
  })

  function presetButton(name: string) {
    return screen.getByRole('button', { name })
  }

  function validation() {
    return new api.ApiRequestError(
      400,
      'VALIDATION_ERROR',
      'Invalid range',
      'to',
    )
  }

  it('defaults to This month: only the browser zone is sent', async () => {
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('$69.51')

    const group = screen.getByRole('group', { name: 'Date range' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['This month', 'Last 30 days', 'All time', 'Custom'])
    expect(presetButton('This month')).toHaveAttribute('aria-pressed', 'true')
    expect(presetButton('All time')).toHaveAttribute('aria-pressed', 'false')
    expect(api.getDashboard).toHaveBeenCalledTimes(1)
    expect(api.getDashboard).toHaveBeenLastCalledWith({ tz })
    expect(router.currentRoute.value.fullPath).toBe('/dashboard')
  })

  it("renders the label from the server's resolved range", async () => {
    vi.mocked(api.getDashboard).mockResolvedValue(
      resolved('month', '2026-11-01', '2026-11-01'),
    )
    await renderWithRouter(DashboardView, { path: '/dashboard' })

    expect(await screen.findByText('Nov 1, 2026')).toBeVisible()
  })

  it('places the range control above the metric cards', async () => {
    await renderWithRouter(DashboardView, { path: '/dashboard' })
    const tile = await screen.findByRole('group', { name: 'GMV' })

    const control = screen.getByRole('group', { name: 'Date range' })
    expect(
      control.compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('Last 30 days pushes ?range=last30 and requests it', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('$69.51')
    const push = vi.spyOn(router, 'push')

    await user.click(presetButton('Last 30 days'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe(
        '/dashboard?range=last30',
      ),
    )
    expect(push).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(api.getDashboard).toHaveBeenLastCalledWith({
        range: 'last30',
        tz,
      }),
    )
    expect(presetButton('Last 30 days')).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByText('Sep 8 – Oct 7, 2026')).toBeVisible()
  })

  it('All time is explicit in the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('$69.51')

    await user.click(presetButton('All time'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/dashboard?range=all'),
    )
    await vi.waitFor(() =>
      expect(api.getDashboard).toHaveBeenLastCalledWith({ range: 'all', tz }),
    )
    expect(
      await screen.findByText('All time', { selector: 'strong' }),
    ).toBeVisible()
  })

  it('This month clears the params again', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard?range=all',
    })
    await screen.findByText('$69.51')

    await user.click(presetButton('This month'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/dashboard'),
    )
    await vi.waitFor(() => expect(lastRequest()).toEqual({ tz }))
    expect(presetButton('This month')).toHaveAttribute('aria-pressed', 'true')
  })

  it('restores a preset from the URL on load', async () => {
    await renderWithRouter(DashboardView, { path: '/dashboard?range=all' })
    await screen.findByText('$69.51')

    expect(api.getDashboard).toHaveBeenCalledTimes(1)
    expect(api.getDashboard).toHaveBeenCalledWith({ range: 'all', tz })
    expect(presetButton('All time')).toHaveAttribute('aria-pressed', 'true')
  })

  it('restores custom days from the URL on load', async () => {
    await renderWithRouter(DashboardView, {
      path: '/dashboard?range=custom&from=2026-09-01&to=2026-09-15',
    })

    expect(await screen.findByText('Sep 1 – Sep 15, 2026')).toBeVisible()
    expect(api.getDashboard).toHaveBeenCalledTimes(1)
    expect(api.getDashboard).toHaveBeenCalledWith({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-15',
      tz,
    })
    expect(presetButton('Custom')).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('combobox', { name: 'Custom date range' }),
    ).toHaveValue('2026-09-01 - 2026-09-15')
  })

  it('normalizes an explicit range=month, the default, out of the URL', async () => {
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard?range=month&q=vit',
    })
    await screen.findByText('$69.51')

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/dashboard?q=vit'),
    )
    expect(api.getDashboard).toHaveBeenCalledTimes(1)
    expect(api.getDashboard).toHaveBeenCalledWith({ tz })
  })

  it.each([
    ['reversed days', '?range=custom&from=2026-10-07&to=2026-10-01'],
    ['an unknown preset', '?range=week'],
    ['days without custom', '?range=all&from=2026-10-01&to=2026-10-02'],
    ['custom without days', '?range=custom'],
  ])(
    'falls back to the default when the server rejects %s, and cleans the URL',
    async (_, search) => {
      vi.mocked(api.getDashboard).mockRejectedValueOnce(validation())
      const { router } = await renderWithRouter(DashboardView, {
        path: `/dashboard${search}&q=vit`,
      })

      await screen.findByText('$69.51')

      await vi.waitFor(() =>
        expect(router.currentRoute.value.fullPath).toBe('/dashboard?q=vit'),
      )
      expect(api.getDashboard).toHaveBeenCalledTimes(2)
      expect(api.getDashboard).toHaveBeenNthCalledWith(2, { tz })
      expect(presetButton('This month')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it('shows the error when even the default range is rejected', async () => {
    vi.mocked(api.getDashboard).mockRejectedValue(validation())
    await renderWithRouter(DashboardView, { path: '/dashboard' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid range')
    expect(api.getDashboard).toHaveBeenCalledTimes(1)
  })

  it('Back restores the previous range and refetches it', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('$69.51')
    await user.click(presetButton('All time'))
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query.range).toBe('all'),
    )
    await vi.waitFor(() => expect(lastRequest()).toEqual({ range: 'all', tz }))

    router.back()

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/dashboard'),
    )
    await vi.waitFor(() => expect(lastRequest()).toEqual({ tz }))
    expect(presetButton('This month')).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps inventory search and page when the range changes, and vice versa', async () => {
    const user = userEvent.setup()
    vi.mocked(api.searchProducts).mockImplementation(serveProducts)
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard?q=vit&range=all',
    })
    await screen.findByText('Vitamin D3')

    await user.click(screen.getByRole('button', { name: 'Next Page' }))

    await screen.findByText('Zinc')
    expect(router.currentRoute.value.query).toEqual({
      q: 'vit',
      page: '2',
      range: 'all',
    })

    await user.click(presetButton('This month'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({
        q: 'vit',
        page: '2',
      }),
    )
    // Inventory is not date-filtered, so it is not reloaded for a range change.
    expect(api.searchProducts).toHaveBeenCalledTimes(2)
  })

  it('Custom reveals a labeled date picker without changing the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('$69.51')

    await user.click(presetButton('Custom'))

    expect(presetButton('Custom')).toHaveAttribute('aria-pressed', 'true')
    expect(presetButton('This month')).toHaveAttribute('aria-pressed', 'false')
    expect(
      screen.getByRole('combobox', { name: 'Custom date range' }),
    ).toBeInTheDocument()
    expect(router.currentRoute.value.fullPath).toBe('/dashboard')
    expect(api.getDashboard).toHaveBeenCalledTimes(1)
  })

  it('applies a typed custom range once it is complete', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('$69.51')
    await user.click(presetButton('Custom'))
    const input = screen.getByRole('combobox', { name: 'Custom date range' })

    await user.clear(input)
    await user.type(input, '2026-08-03 - 2026-08-09')
    await user.tab()

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe(
        '/dashboard?range=custom&from=2026-08-03&to=2026-08-09',
      ),
    )
    await vi.waitFor(() =>
      expect(api.getDashboard).toHaveBeenLastCalledWith({
        range: 'custom',
        from: '2026-08-03',
        to: '2026-08-09',
        tz,
      }),
    )
    expect(await screen.findByText('Aug 3 – Aug 9, 2026')).toBeVisible()
  })

  it('shows Loading… in place of the cards while a range loads', async () => {
    const user = userEvent.setup()
    await renderWithRouter(DashboardView, { path: '/dashboard' })
    await screen.findByText('$69.51')
    let resolve: (value: DashboardDto) => void = () => {}
    vi.mocked(api.getDashboard).mockReturnValueOnce(
      new Promise<DashboardDto>((done) => {
        resolve = done
      }),
    )

    await user.click(presetButton('All time'))

    const sales = screen.getByRole('region', { name: 'Sales' })
    await within(sales).findByText('Loading…')
    expect(within(sales).queryByText('$69.51')).not.toBeInTheDocument()
    // The control stays usable while loading.
    expect(presetButton('All time')).toBeEnabled()

    resolve({ ...resolved('all', null, null), gmvCents: 100 })
    expect(await within(sales).findByText('$1.00')).toBeInTheDocument()
  })

  it('shows an error with Retry that re-requests the same range', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getDashboard)
      .mockReset()
      .mockRejectedValueOnce(new api.ApiRequestError(500, 'INTERNAL', 'boom'))
    await renderWithRouter(DashboardView, { path: '/dashboard?range=last30' })
    const sales = screen.getByRole('region', { name: 'Sales' })
    await within(sales).findByRole('alert')

    vi.mocked(api.getDashboard).mockResolvedValueOnce(dashboard)
    await user.click(within(sales).getByRole('button', { name: /retry/i }))

    expect(await within(sales).findByText('$69.51')).toBeInTheDocument()
    expect(api.getDashboard).toHaveBeenCalledTimes(2)
    expect(api.getDashboard).toHaveBeenLastCalledWith({ range: 'last30', tz })
  })

  it('ignores a slow response for a range the user already left', async () => {
    const user = userEvent.setup()
    await renderWithRouter(DashboardView, { path: '/dashboard' })
    await screen.findByText('$69.51')
    let resolveSlow: (value: DashboardDto) => void = () => {}
    vi.mocked(api.getDashboard)
      .mockReturnValueOnce(
        new Promise<DashboardDto>((done) => {
          resolveSlow = done
        }),
      )
      .mockResolvedValueOnce({ ...resolved('all', null, null), gmvCents: 200 })

    await user.click(presetButton('Last 30 days'))
    await user.click(presetButton('All time'))
    expect(await screen.findByText('$2.00')).toBeInTheDocument()
    resolveSlow({ ...dashboard, gmvCents: 999 })

    await vi.waitFor(() => expect(screen.queryByText('$9.99')).toBeNull())
    expect(screen.getByText('$2.00')).toBeInTheDocument()
  })
})
