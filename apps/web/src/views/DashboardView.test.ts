import type {
  AwaitingPaymentOrderDto,
  AwaitingPaymentPageDto,
  DashboardDto,
  ProductDto,
} from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import DashboardView from './DashboardView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getDashboard: vi.fn(),
    searchProducts: vi.fn(),
    listAwaitingPayment: vi.fn(),
  }
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

function awaiting(
  id: number,
  patientName: string,
  sentAt: string,
): AwaitingPaymentOrderDto {
  return {
    id,
    patientId: id,
    patientName,
    patientDateOfBirth: '1984-03-14',
    totalCents: 12000,
    sentAt,
  }
}

function awaitingPage(
  items: AwaitingPaymentOrderDto[],
  total = items.length,
  offset = 0,
): AwaitingPaymentPageDto {
  return { items, total, offset, limit: 25 }
}

beforeEach(() => {
  vi.mocked(api.listAwaitingPayment)
    .mockReset()
    .mockResolvedValue(awaitingPage([]))
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

describe('DashboardView awaiting payment', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('comes first, listing sent date, patient and DOB, total, and days waiting', async () => {
    // Only Date is faked, and only here: this test never clicks, and a frozen
    // clock kept the row-click test from navigating.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 6, 9, 0))
    const sentAt = new Date(2026, 9, 1, 12, 0).toISOString()
    vi.mocked(api.listAwaitingPayment).mockResolvedValue(
      awaitingPage([awaiting(12, 'Avery Chen', sentAt)]),
    )
    await renderWithRouter(DashboardView)

    const table = await screen.findByRole('table', {
      name: 'Awaiting payment',
    })
    const sections = screen.getAllByRole('heading', { level: 2 })
    expect(sections.map((heading) => heading.textContent)).toEqual([
      'Awaiting payment',
      'Sales',
      'Inventory',
    ])
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Sent', 'Patient', 'Patient total', 'Days waiting'])
    const row = within(table).getByRole('row', { name: /Avery Chen/ })
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual([
      new Date(sentAt).toLocaleDateString(),
      'Avery Chen · 03/14/1984',
      '$120.00',
      '5',
    ])
    expect(api.listAwaitingPayment).toHaveBeenCalledWith({
      offset: 0,
      limit: 25,
    })
  })

  it('shows the empty state when nothing is pending', async () => {
    await renderWithRouter(DashboardView)

    expect(
      await screen.findByText('Nothing awaiting payment.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('table', { name: 'Awaiting payment' }),
    ).not.toBeInTheDocument()
  })

  it('pages through the orders on the server', async () => {
    const user = userEvent.setup()
    const sentAt = new Date(2026, 9, 1, 12, 0).toISOString()
    const firstPage = Array.from({ length: 25 }, (_, index) =>
      awaiting(index + 1, `Patient ${index + 1}`, sentAt),
    )
    vi.mocked(api.listAwaitingPayment)
      .mockResolvedValueOnce(awaitingPage(firstPage, 30))
      .mockResolvedValueOnce(
        awaitingPage([awaiting(26, 'Riley Park', sentAt)], 30, 25),
      )
    await renderWithRouter(DashboardView)
    const section = await screen.findByRole('region', {
      name: 'Awaiting payment',
    })
    expect(
      await within(section).findByText('Showing 1–25 of 30'),
    ).toBeInTheDocument()
    // Two paginators on one page: each navigation landmark needs its own name.
    await screen.findByText('Vitamin D3')
    expect(within(section).getByRole('navigation')).toHaveAccessibleName(
      'Awaiting payment pages',
    )
    expect(
      screen.getByRole('navigation', { name: 'Inventory pages' }),
    ).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Next Page' }))

    expect(
      await within(section).findByText('Riley Park · 03/14/1984'),
    ).toBeInTheDocument()
    expect(api.listAwaitingPayment).toHaveBeenLastCalledWith({
      offset: 25,
      limit: 25,
    })
    expect(within(section).getByText('Showing 26–26 of 30')).toBeInTheDocument()
  })

  it('opens the order when its row is clicked', async () => {
    const user = userEvent.setup()
    const sentAt = new Date(2026, 9, 1, 12, 0).toISOString()
    vi.mocked(api.listAwaitingPayment).mockResolvedValue(
      awaitingPage([
        awaiting(12, 'Avery Chen', sentAt),
        awaiting(13, 'Sam Ortiz', sentAt),
      ]),
    )
    const { router } = await renderWithRouter(DashboardView)

    await user.click(await screen.findByText('Sam Ortiz · 03/14/1984'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/orders/13'),
    )
  })

  it('opens the order when Enter is pressed on a focused row', async () => {
    const user = userEvent.setup()
    const sentAt = new Date(2026, 9, 1, 12, 0).toISOString()
    vi.mocked(api.listAwaitingPayment).mockResolvedValue(
      awaitingPage([awaiting(12, 'Avery Chen', sentAt)]),
    )
    const { router } = await renderWithRouter(DashboardView)
    const row = await screen.findByRole('row', { name: /Avery Chen/ })
    await screen.findByText('Vitamin D3')

    // The section comes first, so its first row is the page's first tab stop.
    await user.tab()
    expect(row).toHaveFocus()
    await user.keyboard('{Enter}')

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/orders/12'),
    )
  })
})
