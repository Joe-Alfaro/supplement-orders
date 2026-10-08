import type { ProviderOrderDetailDto } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import ProviderOrderView from './ProviderOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getOrder: vi.fn(),
    cancelOrder: vi.fn(),
    deleteOrder: vi.fn(),
    reopenOrder: vi.fn(),
  }
})

const original: ProviderOrderDetailDto = {
  id: 42,
  view: 'provider',
  revision: 2,
  status: 'pending_payment',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: null,
  cancelledAt: null,
  split: null,
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St',
  lines: [
    {
      lineId: 1,
      availableQuantity: 5,
      payableQuantity: 2,
      shortQuantity: 0,
      productId: 3,
      productName: 'Zinc',
      sku: 'ZINC',
      quantity: 2,
      unitPriceCents: 500,
      lineTotalCents: 1000,
      unitCogsCents: 300,
      markupBps: 6666,
      minUnitPriceCents: 303,
      stockQuantity: 5,
    },
  ],
  payment: null,
  ledger: [],
  splitFromOrderId: null,
  backorderOrderId: 77,
  partialPaymentQuote: null,
  blockedByOrderId: null,
  paymentInProgress: null,
  backorderStatus: null,
}

async function openOrder(order: ProviderOrderDetailDto) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  await renderWithRouter(ProviderOrderView, {
    path: `/orders/${order.id}`,
    props: { orderId: String(order.id) },
  })
  await screen.findByRole('heading', { name: new RegExp(`Order #${order.id}`) })
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.cancelOrder).mockReset()
  vi.mocked(api.deleteOrder).mockReset()
})

describe('ProviderOrderView back-order chains (15.3)', () => {
  it('warns in the cancel confirm that back-orders are cancelled too', async () => {
    const user = userEvent.setup()
    await openOrder(original)

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Cancel order',
    })
    expect(dialog).toHaveTextContent('Its back-orders will be cancelled too.')
    expect(
      within(dialog).getByRole('button', { name: 'Keep order' }),
    ).toHaveFocus()
  })

  it('keeps the plain cancel prompt when there is no back-order', async () => {
    const user = userEvent.setup()
    await openOrder({ ...original, backorderOrderId: null })

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Cancel order',
    })
    expect(dialog).not.toHaveTextContent('back-orders')
  })

  it('shows the cascade note on a cancelled original', async () => {
    await openOrder({
      ...original,
      status: 'cancelled',
      cancelledAt: '2026-10-06T09:00:00.000Z',
      backorderStatus: 'cancelled',
    })

    expect(
      screen.getByText('Back-order #77 was cancelled with this order.'),
    ).toBeInTheDocument()
  })

  it('does not show the cascade note on a live original', async () => {
    await openOrder(original)
    expect(screen.queryByText(/was cancelled with this order/)).toBeNull()
  })

  it('mentions linked back-orders in the delete-draft confirm', async () => {
    const user = userEvent.setup()
    await openOrder({ ...original, status: 'draft' })

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete draft',
    })
    expect(dialog).toHaveTextContent(
      'Its linked back-orders will be deleted too.',
    )
  })

  it('keeps the plain delete prompt for a draft with no back-order', async () => {
    const user = userEvent.setup()
    await openOrder({ ...original, status: 'draft', backorderOrderId: null })

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete draft',
    })
    expect(dialog).not.toHaveTextContent('back-orders')
  })

  it('shows a paid order line with the snapshot product name', async () => {
    await openOrder({
      ...original,
      status: 'paid',
      paidAt: '2026-10-05T12:10:00.000Z',
      lines: original.lines.map((line) => ({
        ...line,
        productName: 'Zinc (as sold)',
      })),
    })
    expect(screen.getByText('Zinc (as sold)')).toBeInTheDocument()
  })
})
