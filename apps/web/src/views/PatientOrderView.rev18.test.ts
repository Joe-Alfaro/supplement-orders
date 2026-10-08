import type { PatientOrderDetailDto } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import PatientOrderView from './PatientOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getOrder: vi.fn(), payOrder: vi.fn() }
})

function side(totalCents: number) {
  return { subtotalCents: totalCents, totalCents }
}

const shortLine: PatientOrderDetailDto['lines'][number] = {
  lineId: 1,
  productId: 1,
  productName: 'Product 1',
  sku: 'SKU1',
  quantity: 3,
  unitPriceCents: 1000,
  lineTotalCents: 3000,
  availableQuantity: 1,
  payableQuantity: 1,
  shortQuantity: 2,
}

const base: PatientOrderDetailDto = {
  id: 42,
  view: 'patient',
  revision: 3,
  status: 'pending_payment',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: null,
  cancelledAt: null,
  patientAddress: '214 Alder St',
  totalCents: 3000,
  lines: [shortLine],
  payment: null,
  splitFromOrderId: null,
  backorderOrderId: 57,
  partialPaymentQuote: null,
  blockedByOrderId: null,
  paymentInProgress: null,
  backorderStatus: 'awaiting_stock',
}

// The quote's `reason` is new in revision 18; the domain type gains it on merge.
const awaitingRestock = {
  ...base,
  partialPaymentQuote: {
    pay: side(1000),
    backorder: side(2000),
    payable: false,
    hasShortfall: true,
    reason: 'awaiting_restock',
  },
} as PatientOrderDetailDto

async function renderOrder(order: PatientOrderDetailDto) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  await renderWithRouter(PatientOrderView, {
    path: '/my-orders/42',
    props: { orderId: '42' },
  })
  await screen.findByRole('heading', { name: /Order #42/ })
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.payOrder).mockReset()
})

describe('PatientOrderView awaiting restock (18.1)', () => {
  it('hides every pay button and explains, with a link to the back-order', async () => {
    await renderOrder(awaitingRestock)

    expect(screen.getByRole('status')).toHaveTextContent(
      "Some items are still on back-order #57. You can pay once they're back in stock.",
    )
    expect(
      within(screen.getByRole('status')).getByRole('link', { name: '#57' }),
    ).toHaveAttribute('href', '/my-orders/57')
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
    expect(
      screen.queryByRole('button', { name: /Complete payment/ }),
    ).toBeNull()
  })

  it('also hides pay when the status already reads awaiting_stock', async () => {
    await renderOrder({ ...awaitingRestock, status: 'awaiting_stock' })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Some items are still on back-order #57',
    )
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
  })

  it('does not show the notice for an ordinary payable quote', async () => {
    await renderOrder({
      ...base,
      partialPaymentQuote: {
        pay: side(1000),
        backorder: side(2000),
        payable: true,
        hasShortfall: true,
      },
    })

    expect(screen.queryByText(/still on back-order/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Pay $10.00 for in-stock items' }),
    ).toBeEnabled()
  })
})

describe('PatientOrderView payment pending (18.2)', () => {
  it('reloads into the processing state on 503 PAYMENT_PENDING', async () => {
    const user = userEvent.setup()
    const ready: PatientOrderDetailDto = {
      ...base,
      backorderOrderId: null,
      backorderStatus: null,
      lines: [
        {
          ...shortLine,
          availableQuantity: 3,
          payableQuantity: 3,
          shortQuantity: 0,
        },
      ],
      partialPaymentQuote: {
        pay: side(3000),
        backorder: side(0),
        payable: true,
        hasShortfall: false,
      },
    }
    await renderOrder(ready)
    vi.mocked(api.payOrder).mockRejectedValue(
      new api.ApiRequestError(
        503,
        'PAYMENT_PENDING' as never,
        'Payment is being processed',
      ),
    )
    vi.mocked(api.getOrder).mockResolvedValue({
      ...ready,
      paymentInProgress: { revision: 3, amountCents: 3000 },
    })

    await user.click(screen.getByRole('button', { name: 'Pay $30.00' }))

    expect(
      await screen.findByText('Your payment is being processed'),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Complete payment' }),
    ).toBeEnabled()
    expect(screen.queryByText(/Payment failed/)).toBeNull()
  })
})
