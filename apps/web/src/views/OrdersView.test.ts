import type {
  ListOrdersQuery,
  OrderStatus,
  ProviderOrderListItemDto,
  ProviderOrderListPageDto,
} from '@supplement-orders/domain'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { expectNoAxeViolations } from '../a11y/expectNoAxeViolations'
import { renderWithRouter } from '../test/renderWithRouter'
import OrdersView from './OrdersView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, listProviderOrders: vi.fn() }
})

const base = {
  patientId: 7,
  patientName: 'Jordan Lee',
  patientDateOfBirth: '1984-03-14',
  createdAt: '2026-10-01T15:00:00.000Z',
  sentAt: null,
  paidAt: null,
  cancelledAt: null,
  totalCents: null,
  splitFromOrderId: null,
  backorderOrderId: null,
  blockedByOrderId: null,
}

const ORDERS: Record<OrderStatus, ProviderOrderListItemDto> = {
  awaiting_stock: {
    ...base,
    id: 16,
    status: 'awaiting_stock',
    totalCents: 1000,
    sentAt: '2026-10-02T15:00:00.000Z',
  },
  pending_payment: {
    ...base,
    id: 12,
    status: 'pending_payment',
    totalCents: 6251,
    sentAt: '2026-10-02T15:00:00.000Z',
  },
  draft: { ...base, id: 13, status: 'draft' },
  paid: {
    ...base,
    id: 14,
    status: 'paid',
    totalCents: 4233,
    sentAt: '2026-10-02T15:00:00.000Z',
    paidAt: '2026-10-03T15:00:00.000Z',
  },
  cancelled: {
    ...base,
    id: 15,
    status: 'cancelled',
    totalCents: 1000,
    sentAt: '2026-10-02T15:00:00.000Z',
    cancelledAt: '2026-10-04T15:00:00.000Z',
  },
}

/** A fake provider order list; "cancelled only" has no orders, for the empty state. */
function orderPage(
  query: { statuses: readonly OrderStatus[] } & ListOrdersQuery,
): ProviderOrderListPageDto {
  // The DTO status type learns awaiting_stock when the domain package does.
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  if (query.statuses.length === 1 && query.statuses[0] === 'cancelled') {
    return { items: [], total: 0, offset, limit }
  }
  const items = Object.values(ORDERS).filter(
    (order) =>
      query.statuses.length === 0 || query.statuses.includes(order.status),
  )
  return {
    items,
    total: items.length + 26,
    offset,
    limit,
  }
}

function lastStatuses() {
  return vi.mocked(api.listProviderOrders).mock.lastCall?.[0].statuses
}

function lastOffset() {
  return vi.mocked(api.listProviderOrders).mock.lastCall?.[0].offset
}

/** Opens the Status list from its focused combobox, as a keyboard user would. */
async function openStatusList(user: UserEvent) {
  screen.getByRole('combobox', { name: 'Status' }).focus()
  await user.keyboard('{ArrowDown}')
  return screen.findByRole('listbox')
}

function option(name: string) {
  return screen.getByRole('option', { name })
}

function selectedOptions() {
  return screen
    .getAllByRole('option')
    .filter((node) => node.getAttribute('aria-selected') === 'true')
    .map((node) => node.getAttribute('aria-label'))
}

const ALL = ['Draft', 'Awaiting payment', 'Awaiting stock', 'Paid', 'Cancelled']

beforeEach(() => {
  vi.mocked(api.listProviderOrders)
    .mockReset()
    .mockImplementation(async (query) => orderPage(query))
})

describe('OrdersView', () => {
  it('defaults to every status checked, newest activity, with no status in the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })

    const table = await screen.findByRole('table', { name: 'Orders' })
    // Every status is no filter: the API gets status=all (an empty list).
    expect(api.listProviderOrders).toHaveBeenCalledWith({
      statuses: [],
      offset: 0,
      limit: 25,
    })
    expect(router.currentRoute.value.query).toEqual({})
    expect(within(table).getAllByRole('row')).toHaveLength(6)
    expect(
      within(table).getByRole('columnheader', { name: 'Date' }),
    ).toBeInTheDocument()
    const row = within(table).getByRole('row', { name: /#12/ })
    expect(row).toHaveTextContent('Jordan Lee · 03/14/1984')
    expect(row).toHaveTextContent('$62.51')

    await openStatusList(user)
    expect(selectedOptions()).toEqual(ALL)
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeChecked()
  })

  it('unchecking Paid shows every order except paid; rechecking it clears the URL again', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' })

    await user.click(option('Paid'))
    await vi.waitFor(() =>
      expect(lastStatuses()).toEqual([
        'draft',
        'pending_payment',
        'awaiting_stock',
        'cancelled',
      ]),
    )
    // Unchecking one status clears the select-all box.
    expect(selectAll).not.toBeChecked()
    expect(router.currentRoute.value.query).toEqual({
      status: 'draft,pending_payment,awaiting_stock,cancelled',
    })
    const table = screen.getByRole('table', { name: 'Orders' })
    await vi.waitFor(() =>
      expect(
        within(table).queryByRole('row', { name: /#14/ }),
      ).not.toBeInTheDocument(),
    )
    ;[/#12/, /#13/, /#15/].forEach((name) =>
      expect(within(table).getByRole('row', { name })).toBeInTheDocument(),
    )

    await user.click(option('Paid'))
    await vi.waitFor(() => expect(lastStatuses()).toEqual([]))
    expect(selectAll).toBeChecked()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('an empty selection also means all statuses, with the "All statuses" placeholder', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)

    await user.click(screen.getByRole('checkbox', { name: 'Select all' }))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ status: 'all' }),
    )
    expect(lastStatuses()).toEqual([])
    expect(selectedOptions()).toEqual([])
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveAttribute(
      'placeholder',
      'All statuses',
    )
    expect(screen.getByText('All statuses')).toBeInTheDocument()
  })

  it.each([
    [
      '/orders?status=pending_payment',
      ['pending_payment'],
      ['Awaiting payment'],
    ],
    ['/orders?status=awaiting_stock', ['awaiting_stock'], ['Awaiting stock']],
    ['/orders?status=paid', ['paid'], ['Paid']],
    ['/orders?status=paid,draft', ['draft', 'paid'], ['Draft', 'Paid']],
    ['/orders?status=all', [], []],
    ['/orders?status=bogus', [], ALL],
    ['/orders', [], ALL],
  ])('deep link %s selects exactly that', async (path, statuses, shown) => {
    const user = userEvent.setup()
    await renderWithRouter(OrdersView, { path })
    await screen.findByText(/Showing|No /)

    expect(api.listProviderOrders).toHaveBeenCalledWith({
      statuses,
      offset: 0,
      limit: 25,
    })
    await openStatusList(user)
    expect(selectedOptions()).toEqual(shown)
  })

  it('restores the page from ?page= and keeps it in the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, {
      path: '/orders?status=paid&page=2',
    })
    await screen.findByRole('table', { name: 'Orders' })
    expect(api.listProviderOrders).toHaveBeenCalledWith({
      statuses: ['paid'],
      offset: 25,
      limit: 25,
    })

    await user.click(screen.getByRole('button', { name: 'Previous Page' }))
    await vi.waitFor(() => expect(lastOffset()).toBe(0))
    // Page 1 is the default, so it's omitted.
    expect(router.currentRoute.value.query).toEqual({ status: 'paid' })

    await user.click(screen.getByRole('button', { name: 'Next Page' }))
    await vi.waitFor(() => expect(lastOffset()).toBe(25))
    expect(router.currentRoute.value.query).toEqual({
      status: 'paid',
      page: '2',
    })
  })

  it('a filter change goes back to page 1', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, {
      path: '/orders?page=2',
    })
    await screen.findByRole('table', { name: 'Orders' })
    expect(lastOffset()).toBe(25)
    await openStatusList(user)

    await user.click(option('Draft'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({
        status: 'pending_payment,awaiting_stock,paid,cancelled',
      }),
    )
    expect(lastOffset()).toBe(0)
  })

  it('Back and Forward step through filter and page changes', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)
    await user.click(option('Paid'))
    await vi.waitFor(() =>
      expect(lastStatuses()).toEqual([
        'draft',
        'pending_payment',
        'awaiting_stock',
        'cancelled',
      ]),
    )
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Next Page' }))
    await vi.waitFor(() => expect(lastOffset()).toBe(25))

    router.back()
    await vi.waitFor(() => expect(lastOffset()).toBe(0))
    expect(lastStatuses()).toEqual([
      'draft',
      'pending_payment',
      'awaiting_stock',
      'cancelled',
    ])

    router.back()
    await vi.waitFor(() => expect(lastStatuses()).toEqual([]))
    expect(router.currentRoute.value.query).toEqual({})

    router.forward()
    await vi.waitFor(() =>
      expect(lastStatuses()).toEqual([
        'draft',
        'pending_payment',
        'awaiting_stock',
        'cancelled',
      ]),
    )
    await openStatusList(user)
    expect(selectedOptions()).toEqual([
      'Draft',
      'Awaiting payment',
      'Awaiting stock',
      'Cancelled',
    ])
  })

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup()
    await renderWithRouter(OrdersView, { path: '/orders?status=draft' })
    await screen.findByRole('table', { name: 'Orders' })

    await user.tab()
    const combobox = screen.getByRole('combobox', { name: 'Status' })
    expect(combobox).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(combobox).toHaveAttribute('aria-expanded', 'true')

    // The active option starts on the selected one (Draft); move to Paid and toggle it.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    await user.keyboard(' ')
    await vi.waitFor(() => expect(lastStatuses()).toEqual(['draft', 'paid']))
    expect(option('Paid')).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Escape}')
    await vi.waitFor(() =>
      expect(combobox).toHaveAttribute('aria-expanded', 'false'),
    )
  })

  it('shows an empty state specific to the selection', async () => {
    await renderWithRouter(OrdersView, { path: '/orders?status=cancelled' })

    expect(await screen.findByText('No cancelled orders.')).toBeInTheDocument()
    expect(
      screen.queryByRole('table', { name: 'Orders' }),
    ).not.toBeInTheDocument()
  })

  it('opens the order from a row click or Enter', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })

    await user.click(screen.getByText('#14'))
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/orders/14'),
    )

    screen.getByRole('row', { name: /#12/ }).focus()
    await user.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/orders/12'),
    )
  })

  it('has no axe violations with the status list open', async () => {
    const user = userEvent.setup()
    const view = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)

    // The list renders inside the component (append-to self), so the view covers it.
    expect(view.container).toContainElement(screen.getByRole('listbox'))
    await expectNoAxeViolations(view.container)
  })

  it('filters to Awaiting stock: the back-order is listed and the paid original is not', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)

    await user.click(screen.getByRole('checkbox', { name: 'Select all' }))
    await user.click(option('Awaiting stock'))

    await vi.waitFor(() => expect(lastStatuses()).toEqual(['awaiting_stock']))
    expect(router.currentRoute.value.query).toEqual({
      status: 'awaiting_stock',
    })
    const table = await screen.findByRole('table', { name: 'Orders' })
    expect(within(table).getByRole('row', { name: /#16/ })).toHaveTextContent(
      'Awaiting stock',
    )
    expect(within(table).queryByRole('row', { name: /#14/ })).toBeNull()
  })
})
