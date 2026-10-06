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
}

const ORDERS: Record<OrderStatus, ProviderOrderListItemDto> = {
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
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  if (query.statuses.length === 1 && query.statuses[0] === 'cancelled') {
    return { items: [], total: 0, offset, limit }
  }
  const items = Object.values(ORDERS).filter(
    (order) =>
      query.statuses.length === 0 || query.statuses.includes(order.status),
  )
  return { items, total: items.length + 26, offset, limit }
}

function lastStatuses() {
  return vi.mocked(api.listProviderOrders).mock.lastCall?.[0].statuses
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

beforeEach(() => {
  vi.mocked(api.listProviderOrders)
    .mockReset()
    .mockImplementation(async (query) => orderPage(query))
})

describe('OrdersView', () => {
  it('defaults to Awaiting payment only and lists the order with patient and DOB', async () => {
    const user = userEvent.setup()
    await renderWithRouter(OrdersView, { path: '/orders' })

    const table = await screen.findByRole('table', { name: 'Orders' })
    expect(api.listProviderOrders).toHaveBeenCalledWith({
      statuses: ['pending_payment'],
      offset: 0,
      limit: 25,
    })
    expect(
      within(table).getByRole('columnheader', { name: 'Sent' }),
    ).toBeInTheDocument()
    const row = within(table).getByRole('row', { name: /#12/ })
    expect(row).toHaveTextContent('Jordan Lee · 03/14/1984')
    expect(row).toHaveTextContent('Awaiting payment')
    expect(row).toHaveTextContent('$62.51')
    expect(screen.getByText('Showing 1–1 of 27')).toBeInTheDocument()

    await openStatusList(user)
    expect(option('Awaiting payment')).toHaveAttribute('aria-selected', 'true')
    ;['Draft', 'Paid', 'Cancelled'].forEach((name) =>
      expect(option(name)).toHaveAttribute('aria-selected', 'false'),
    )
  })

  it('select all, then uncheck Paid, shows every order except paid', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)

    const selectAll = screen.getByRole('checkbox', {
      name: 'Select all',
    })
    await user.click(selectAll)
    await vi.waitFor(() =>
      expect(lastStatuses()).toEqual([
        'draft',
        'pending_payment',
        'paid',
        'cancelled',
      ]),
    )
    expect(selectAll).toBeChecked()

    await user.click(option('Paid'))
    await vi.waitFor(() =>
      expect(lastStatuses()).toEqual(['draft', 'pending_payment', 'cancelled']),
    )
    // Unchecking one status clears the select-all box.
    expect(selectAll).not.toBeChecked()
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({
        status: 'draft,pending_payment,cancelled',
      }),
    )
    const table = screen.getByRole('table', { name: 'Orders' })
    await vi.waitFor(() =>
      expect(within(table).queryByRole('row', { name: /#14/ })).toBeNull(),
    )
    ;[/#12/, /#13/, /#15/].forEach((name) =>
      expect(within(table).getByRole('row', { name })).toBeInTheDocument(),
    )
    expect(
      within(table).getByRole('columnheader', { name: 'Date' }),
    ).toBeInTheDocument()
  })

  it('an empty selection means all statuses, with the "All statuses" placeholder', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })
    await openStatusList(user)

    await user.click(option('Awaiting payment'))

    await vi.waitFor(() => expect(lastStatuses()).toEqual([]))
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveAttribute(
      'placeholder',
      'All statuses',
    )
    expect(screen.getByText('All statuses')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ status: 'all' }),
    )
    const table = screen.getByRole('table', { name: 'Orders' })
    await vi.waitFor(() =>
      expect(within(table).getAllByRole('row')).toHaveLength(5),
    )
  })

  it.each([
    ['/orders?status=paid,draft', ['draft', 'paid']],
    ['/orders?status=all', []],
    ['/orders?status=bogus', ['pending_payment']],
    ['/orders', ['pending_payment']],
  ])('reads the selection from %s', async (path, statuses) => {
    await renderWithRouter(OrdersView, { path })
    await screen.findByRole('table', { name: 'Orders' })

    expect(api.listProviderOrders).toHaveBeenCalledWith({
      statuses,
      offset: 0,
      limit: 25,
    })
  })

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup()
    await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })

    await user.tab()
    const combobox = screen.getByRole('combobox', { name: 'Status' })
    expect(combobox).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(combobox).toHaveAttribute('aria-expanded', 'true')

    // The active option starts on the selected one; move to Paid and toggle it.
    await user.keyboard('{ArrowDown}')
    await user.keyboard(' ')
    await vi.waitFor(() =>
      expect(lastStatuses()).toEqual(['pending_payment', 'paid']),
    )
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
    const { router } = await renderWithRouter(OrdersView, {
      path: '/orders?status=all',
    })
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

  it('pages on the server', async () => {
    const user = userEvent.setup()
    await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })

    await user.click(screen.getByRole('button', { name: 'Next Page' }))

    await vi.waitFor(() =>
      expect(api.listProviderOrders).toHaveBeenLastCalledWith({
        statuses: ['pending_payment'],
        offset: 25,
        limit: 25,
      }),
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
})
