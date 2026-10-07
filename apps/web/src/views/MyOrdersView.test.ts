import type { PatientOrderSummaryDto } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import MyOrdersView from './MyOrdersView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, listOrders: vi.fn() }
})

function order(id: number, providerName: string): PatientOrderSummaryDto {
  return {
    id,
    view: 'patient',
    revision: 1,
    status: 'pending_payment',
    patientId: 1,
    patientName: 'Jordan Lee',
    providerId: 1,
    providerName,
    // Same date on purpose: the date alone cannot identify the order.
    createdAt: '2026-10-05T12:00:00.000Z',
    sentAt: '2026-10-05T12:00:00.000Z',
    paidAt: null,
    cancelledAt: null,
    totalCents: 1000,
  }
}

beforeEach(() => {
  vi.mocked(api.listOrders).mockResolvedValue([
    order(11, 'Dr. Maya Rivera'),
    order(12, 'Dr. Owen Brooks'),
  ])
})

describe('MyOrdersView', () => {
  it('opens the order when any cell of its row is clicked', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(MyOrdersView)

    await user.click(await screen.findByText('Dr. Owen Brooks'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders/12'),
    )
  })

  it('opens the order when Enter is pressed on a focused row', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(MyOrdersView)
    const row = await screen.findByRole('row', { name: /Dr. Maya Rivera/ })
    expect(screen.getByRole('table', { name: 'My orders' })).toContainElement(
      row,
    )

    // The first row is the table's single tab stop; arrow keys move between rows.
    expect(row).toHaveAttribute('tabindex', '0')
    await user.tab()
    expect(row).toHaveFocus()
    await user.keyboard('{Enter}')

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders/11'),
    )
  })

  it('lists a cancelled order with a Cancelled tag', async () => {
    vi.mocked(api.listOrders).mockResolvedValue([
      order(11, 'Dr. Maya Rivera'),
      {
        ...order(12, 'Dr. Owen Brooks'),
        status: 'cancelled',
        cancelledAt: '2026-10-06T09:30:00.000Z',
      },
    ])
    await renderWithRouter(MyOrdersView)

    const row = await screen.findByRole('row', { name: /Dr. Owen Brooks/ })
    expect(within(row).getByText('Cancelled')).toBeInTheDocument()
    expect(
      within(screen.getByRole('row', { name: /Dr. Maya Rivera/ })).getByText(
        'Awaiting payment',
      ),
    ).toBeInTheDocument()
  })
})
