import type {
  ListOrdersQuery,
  OrderListStatusFilter,
  ProviderOrderListItemDto,
  ProviderOrderListPageDto,
} from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
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

const ORDERS: Record<
  Exclude<OrderListStatusFilter, 'all'>,
  ProviderOrderListItemDto
> = {
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

/** A fake provider order list: 30 matches for most filters, none for cancelled. */
function orderPage(
  query: { status: OrderListStatusFilter } & ListOrdersQuery,
): ProviderOrderListPageDto {
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  if (query.status === 'cancelled')
    return { items: [], total: 0, offset, limit }
  const items =
    query.status === 'all' ? Object.values(ORDERS) : [ORDERS[query.status]]
  return { items, total: 30, offset, limit }
}

beforeEach(() => {
  vi.mocked(api.listProviderOrders)
    .mockReset()
    .mockImplementation(async (query) => orderPage(query))
})

describe('OrdersView', () => {
  it('defaults to Awaiting payment and lists the order with patient and DOB', async () => {
    await renderWithRouter(OrdersView, { path: '/orders' })

    const table = await screen.findByRole('table', { name: 'Orders' })
    expect(api.listProviderOrders).toHaveBeenCalledWith({
      status: 'pending_payment',
      offset: 0,
      limit: 25,
    })
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent(
      'Awaiting payment',
    )
    expect(
      within(table).getByRole('columnheader', { name: 'Sent' }),
    ).toBeInTheDocument()
    const row = within(table).getByRole('row', { name: /#12/ })
    expect(row).toHaveTextContent('Jordan Lee · 03/14/1984')
    expect(row).toHaveTextContent('Awaiting payment')
    expect(row).toHaveTextContent('$62.51')
    expect(screen.getByText('Showing 1–1 of 30')).toBeInTheDocument()
  })

  it('changes the filter, refetches from the first page, and keeps it in the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(OrdersView, { path: '/orders' })
    await screen.findByRole('table', { name: 'Orders' })

    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'Paid' }))

    await vi.waitFor(() =>
      expect(api.listProviderOrders).toHaveBeenLastCalledWith({
        status: 'paid',
        offset: 0,
        limit: 25,
      }),
    )
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ status: 'paid' }),
    )
    expect(
      await screen.findByRole('columnheader', { name: 'Paid' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /#14/ })).toHaveTextContent('$42.33')
  })

  it('honours ?status=all and shows each row with its own relevant date', async () => {
    await renderWithRouter(OrdersView, { path: '/orders?status=all' })

    const table = await screen.findByRole('table', { name: 'Orders' })
    expect(api.listProviderOrders).toHaveBeenCalledWith({
      status: 'all',
      offset: 0,
      limit: 25,
    })
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent(
      'All statuses',
    )
    expect(
      within(table).getByRole('columnheader', { name: 'Date' }),
    ).toBeInTheDocument()
    expect(within(table).getAllByRole('row')).toHaveLength(5)
    // A draft has no total yet; its date is when it was created.
    const draft = within(table).getByRole('row', { name: /#13/ })
    expect(draft).toHaveTextContent('Draft')
    expect(draft).not.toHaveTextContent('$')
    expect(draft).toHaveTextContent(
      new Date('2026-10-01T15:00:00.000Z').toLocaleDateString(),
    )
    expect(within(table).getByRole('row', { name: /#15/ })).toHaveTextContent(
      new Date('2026-10-04T15:00:00.000Z').toLocaleDateString(),
    )
  })

  it('shows an empty state specific to the filter', async () => {
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
        status: 'pending_payment',
        offset: 25,
        limit: 25,
      }),
    )
  })
})
