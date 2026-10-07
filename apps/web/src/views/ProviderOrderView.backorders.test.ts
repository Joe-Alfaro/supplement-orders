import { screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { ProviderOrderWithLinks } from '../stock'
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

const backorder: ProviderOrderWithLinks = {
  id: 77,
  view: 'provider',
  revision: 1,
  status: 'awaiting_stock',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: null,
  cancelledAt: null,
  split: {
    subtotalCents: 1000,
    platformFeeCents: 8,
    totalCents: 1000,
    cogsCents: 600,
    providerMarginCents: 392,
  },
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St',
  lines: [
    {
      productId: 3,
      productName: 'Zinc',
      sku: 'ZINC',
      quantity: 2,
      unitPriceCents: 500,
      lineTotalCents: 1000,
      unitCogsCents: 300,
      markupBps: 6666,
      minUnitPriceCents: 303,
      stockQuantity: 0,
    },
  ],
  payment: null,
  ledger: [],
  splitFromOrderId: 42,
  backorderOrderId: null,
}

async function renderOrder(order: ProviderOrderWithLinks) {
  vi.mocked(api.getOrder).mockResolvedValue(order as never)
  await renderWithRouter(ProviderOrderView, {
    path: `/orders/${order.id}`,
    props: { orderId: String(order.id) },
  })
  await screen.findByRole('heading', { name: new RegExp(`Order #${order.id}`) })
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset()
})

describe('ProviderOrderView back-orders', () => {
  it('shows the Awaiting stock tag and the link to the original', async () => {
    await renderOrder(backorder)

    expect(screen.getAllByText('Awaiting stock').length).toBeGreaterThan(0)
    expect(screen.getByText(/Back-order of order/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#42' })).toHaveAttribute(
      'href',
      '/orders/42',
    )
  })

  it('offers Cancel only: no Reopen and no Edit', async () => {
    await renderOrder(backorder)

    expect(
      screen.getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Reopen/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Edit/ })).not.toBeInTheDocument()
  })

  it('a cancelled back-order shows no Reopen either', async () => {
    await renderOrder({
      ...backorder,
      status: 'cancelled',
      cancelledAt: '2026-10-06T09:00:00.000Z',
    })

    expect(
      screen.queryByRole('button', { name: /Reopen/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('an Awaiting stock order cancels like an awaiting-payment one', async () => {
    await renderOrder({ ...backorder, splitFromOrderId: null })
    expect(
      screen.getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
  })

  it('links the partially fulfilled original to its back-order', async () => {
    await renderOrder({
      ...backorder,
      id: 42,
      status: 'paid',
      paidAt: '2026-10-05T12:10:00.000Z',
      splitFromOrderId: null,
      backorderOrderId: 77,
    })

    expect(
      screen.getByText(/Partially fulfilled: remaining items moved to order/),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#77' })).toHaveAttribute(
      'href',
      '/orders/77',
    )
  })
})
