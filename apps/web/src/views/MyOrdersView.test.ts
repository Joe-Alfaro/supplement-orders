import type { PatientOrderSummaryDto } from '@supplement-orders/domain'
import { fireEvent, screen } from '@testing-library/vue'
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
    status: 'pending_payment',
    patientId: 1,
    patientName: 'Jordan Lee',
    providerId: 1,
    providerName,
    // Same date on purpose: the date alone cannot identify the order.
    createdAt: '2026-10-05T12:00:00.000Z',
    sentAt: '2026-10-05T12:00:00.000Z',
    paidAt: null,
    totals: { subtotalCents: 1000, platformFeeCents: 8, totalCents: 1008 },
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
    const { router } = await renderWithRouter(MyOrdersView)

    await fireEvent.click(await screen.findByText('Dr. Owen Brooks'))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders/12'),
    )
  })

  it('opens the order when Enter is pressed on a focused row', async () => {
    const { router } = await renderWithRouter(MyOrdersView)
    const row = (await screen.findByText('Dr. Maya Rivera')).closest('tr')
    if (!row) throw new Error('row not found')

    expect(row.tabIndex).toBe(0)
    row.focus()
    await fireEvent.keyDown(row, { key: 'Enter' })

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders/11'),
    )
  })
})
