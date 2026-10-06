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
  id: 42,
  view: 'patient',
  status: 'pending_payment',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: null,
  patientAddress: '214 Alder St, Portland, OR 97205',
  totalCents: 12000,
  lines: [
    {
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
    expect(api.payOrder).toHaveBeenCalledWith(42, {})
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

    await user.click(
      screen.getByRole('checkbox', {
        name: 'Simulate gateway failure (dev only)',
      }),
    )
    await user.click(button)

    expect(await screen.findByText(/Card declined/)).toBeInTheDocument()
    expect(api.payOrder).toHaveBeenCalledWith(42, { simulateFailure: true })
    expect(screen.getByRole('button', { name: 'Pay $120.00' })).toBeEnabled()
    expect(
      screen.queryByRole('heading', { name: 'Receipt' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['pending', pending],
    ['paid', paid],
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
})
