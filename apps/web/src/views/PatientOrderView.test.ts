import type { PatientOrderDetailDto } from '@supplement-orders/domain'
import { fireEvent, screen } from '@testing-library/vue'
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
  totals: { subtotalCents: 12000, platformFeeCents: 90, totalCents: 12090 },
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
    amountCents: 12090,
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

async function renderPayScreen() {
  await renderWithRouter(PatientOrderView, {
    path: '/my-orders/42',
    props: { orderId: '42' },
  })
  return screen.findByRole('button', { name: 'Pay $120.90' })
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset().mockResolvedValue(pending)
  vi.mocked(api.payOrder).mockReset()
})

describe('PatientOrderView', () => {
  it('pays once, disables the button while pending, then shows the receipt', async () => {
    const payment = deferred<PatientOrderDetailDto>()
    vi.mocked(api.payOrder).mockReturnValue(payment.promise)
    const button = await renderPayScreen()

    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(api.payOrder).toHaveBeenCalledTimes(1)
    expect(api.payOrder).toHaveBeenCalledWith(42, {})
    expect(button).toHaveProperty('disabled', true)

    payment.resolve(paid)
    expect(await screen.findByRole('heading', { name: 'Receipt' })).toBeTruthy()
    expect(screen.getByText('fake_ch_123')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull()
  })

  it('shows the gateway error and stays payable on failure', async () => {
    vi.mocked(api.payOrder).mockRejectedValue(
      new api.ApiRequestError(402, 'PAYMENT_FAILED', 'Card declined'),
    )
    const button = await renderPayScreen()

    await fireEvent.click(
      screen.getByLabelText('Simulate gateway failure (dev only)'),
    )
    await fireEvent.click(button)

    expect(await screen.findByText(/Card declined/)).toBeTruthy()
    expect(api.payOrder).toHaveBeenCalledWith(42, { simulateFailure: true })
    const retry = screen.getByRole('button', { name: 'Pay $120.90' })
    expect(retry).toHaveProperty('disabled', false)
    expect(screen.queryByRole('heading', { name: 'Receipt' })).toBeNull()
  })

  it.each([
    ['pending', pending],
    ['paid', paid],
  ])(
    'never renders wholesale cost, COGS or margin (%s)',
    async (_label, order) => {
      vi.mocked(api.getOrder).mockResolvedValue(order)
      const { container } = await renderWithRouter(PatientOrderView, {
        path: '/my-orders/42',
        props: { orderId: '42' },
      })
      await screen.findByRole('heading', { name: /Order #42/ })

      const text = container.textContent ?? ''
      expect(text).not.toMatch(/Wholesale cost/i)
      expect(text).not.toMatch(/COGS/i)
      expect(text).not.toMatch(/margin/i)
    },
  )
})
