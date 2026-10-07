import type { PatientOrderDetailDto } from '@supplement-orders/domain'
import { screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import PatientOrderView from './PatientOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getOrder: vi.fn(), payOrder: vi.fn() }
})

const pending: PatientOrderDetailDto = {
  partialPaymentQuote: null,
  paymentInProgress: null,
  backorderStatus: null,
  splitFromOrderId: null,
  backorderOrderId: null,
  blockedByOrderId: null,
  id: 42,
  view: 'patient',
  revision: 1,
  status: 'pending_payment',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: null,
  cancelledAt: null,
  patientAddress: '214 Alder St, Portland, OR 97205',
  totalCents: 12000,
  lines: [
    {
      payableQuantity: null,
      shortQuantity: null,
      lineId: 911,
      availableQuantity: null,
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 3,
      unitPriceCents: 4000,
      lineTotalCents: 12000,
    },
  ],
  payment: null,
}

const paid: PatientOrderDetailDto = {
  ...pending,
  status: 'paid',
  paidAt: '2026-10-05T12:10:00.000Z',
  payment: {
    id: 5,
    amountCents: 12000,
    reference: 'fake_ch_123',
    createdAt: '2026-10-05T12:10:00.000Z',
  },
}

const cancelled: PatientOrderDetailDto = {
  ...pending,
  status: 'cancelled',
  cancelledAt: '2026-10-06T09:30:00.000Z',
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function openPayScreen() {
  await renderWithRouter(PatientOrderView, {
    path: '/my-orders/42',
    props: { orderId: '42' },
  })
  return screen.findByRole('button', { name: 'Pay $120.00' })
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset().mockResolvedValue(pending)
  vi.mocked(api.payOrder).mockReset()
})

describe('PatientOrderView', () => {
  it('pays once, disables the button while pending, then shows the receipt', async () => {
    const user = userEvent.setup()
    const payment = deferred<PatientOrderDetailDto>()
    vi.mocked(api.payOrder).mockReturnValue(payment.promise)
    const button = await openPayScreen()

    await user.click(button)
    await user.click(button)

    expect(api.payOrder).toHaveBeenCalledTimes(1)
    // It pays exactly the quote on screen (revision 9).
    expect(api.payOrder).toHaveBeenCalledWith(42, {
      expectedRevision: 1,
      expectedTotalCents: 12000,
    })
    expect(button).toBeDisabled()

    payment.resolve(paid)
    expect(
      await screen.findByRole('heading', { name: 'Receipt' }),
    ).toBeInTheDocument()
    expect(screen.getByText('fake_ch_123')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Pay/ }),
    ).not.toBeInTheDocument()
  })

  it('shows the gateway error and stays payable on failure', async () => {
    const user = userEvent.setup()
    vi.mocked(api.payOrder).mockRejectedValue(
      new api.ApiRequestError(402, 'PAYMENT_FAILED', 'Card declined'),
    )
    const button = await openPayScreen()

    await user.click(button)

    expect(await screen.findByText(/Card declined/)).toBeInTheDocument()
    expect(api.payOrder).toHaveBeenCalledWith(42, {
      expectedRevision: 1,
      expectedTotalCents: 12000,
    })
    expect(screen.getByRole('button', { name: 'Pay $120.00' })).toBeEnabled()
    expect(
      screen.queryByRole('heading', { name: 'Receipt' }),
    ).not.toBeInTheDocument()
  })

  it('shows a cancelled order with its lines and total but no Pay button', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(cancelled)
    await renderWithRouter(PatientOrderView, {
      path: '/my-orders/42',
      props: { orderId: '42' },
    })

    expect(
      await screen.findByText('This order was cancelled by your provider.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('Vitamin D3')).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Total' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Pay/ }),
    ).not.toBeInTheDocument()
    expect(api.payOrder).not.toHaveBeenCalled()
  })

  it.each([
    ['pending', pending],
    ['paid', paid],
    ['cancelled', cancelled],
  ])(
    'never renders wholesale cost, COGS, margin, markup, or any fee (%s)',
    async (_label, order) => {
      vi.mocked(api.getOrder).mockResolvedValue(order)
      await renderWithRouter(PatientOrderView, {
        path: '/my-orders/42',
        props: { orderId: '42' },
      })
      await screen.findByRole('heading', { name: /Order #42/ })

      expect(document.body).not.toHaveTextContent(/Wholesale cost/i)
      expect(document.body).not.toHaveTextContent(/COGS/i)
      expect(document.body).not.toHaveTextContent(/margin/i)
      expect(document.body).not.toHaveTextContent(/markup/i)
      expect(document.body).not.toHaveTextContent(/Platform fee/i)
      expect(document.body).not.toHaveTextContent(/Processing fee/i)
    },
  )

  it('when the order changed, explains it, shows the new total, and waits for a fresh click', async () => {
    const user = userEvent.setup()
    const changed: PatientOrderDetailDto = {
      ...pending,
      revision: 2,
      totalCents: 15000,
      lines: [
        {
          payableQuantity: null,
          shortQuantity: null,
          lineId: 910,
          availableQuantity: null,
          productId: 1,
          productName: 'Vitamin D3',
          sku: 'VITD',
          quantity: 3,
          unitPriceCents: 5000,
          lineTotalCents: 15000,
        },
      ],
    }
    vi.mocked(api.payOrder).mockRejectedValueOnce(
      new api.ApiRequestError(
        409,
        'ORDER_CHANGED',
        'This order changed since you opened it. Review the new total before paying.',
      ),
    )
    vi.mocked(api.getOrder)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(changed)
    const button = await openPayScreen()

    await user.click(button)

    expect(
      await screen.findByText(/This order changed since you opened it/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/The total was \$120\.00 and is now/),
    ).toHaveTextContent('The total was $120.00 and is now $150.00.')
    const fresh = await screen.findByRole('button', { name: 'Pay $150.00' })
    // Nothing is retried on the patient's behalf, and no receipt appears.
    expect(api.payOrder).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('heading', { name: 'Receipt' }),
    ).not.toBeInTheDocument()

    vi.mocked(api.payOrder).mockResolvedValueOnce({
      ...paid,
      revision: 2,
      totalCents: 15000,
    })
    await user.click(fresh)

    expect(api.payOrder).toHaveBeenLastCalledWith(42, {
      expectedRevision: 2,
      expectedTotalCents: 15000,
    })
    expect(
      await screen.findByRole('heading', { name: 'Receipt' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/This order changed since you opened it/),
    ).not.toBeInTheDocument()
  })
})
