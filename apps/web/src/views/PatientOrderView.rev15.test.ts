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

function quoteOf(payCents: number, backorderCents: number) {
  const side = (totalCents: number) => ({
    subtotalCents: totalCents,
    totalCents,
  })
  return {
    pay: side(payCents),
    backorder: side(backorderCents),
    payable: payCents > 0,
    hasShortfall: backorderCents > 0,
  }
}

function line(
  lineId: number,
  productId: number,
  quantity: number,
  availableQuantity: number,
  unitPriceCents: number,
): PatientOrderDetailDto['lines'][number] {
  const payable = Math.min(quantity, availableQuantity)
  return {
    lineId,
    productId,
    productName: `Product ${productId}`,
    sku: `SKU${productId}`,
    quantity,
    unitPriceCents,
    lineTotalCents: quantity * unitPriceCents,
    availableQuantity,
    payableQuantity: payable,
    shortQuantity: quantity - payable,
  }
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
  lines: [line(1, 1, 3, 10, 1000)],
  payment: null,
  splitFromOrderId: null,
  backorderOrderId: null,
  partialPaymentQuote: quoteOf(3000, 0),
  blockedByOrderId: null,
  paymentInProgress: null,
  backorderStatus: null,
}

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

describe('PatientOrderView unresolved attempt (15.1)', () => {
  // The order's own reserved unit is gone from free stock (available 0).
  const processing: PatientOrderDetailDto = {
    ...base,
    totalCents: 1000,
    lines: [line(1, 1, 1, 0, 1000)],
    partialPaymentQuote: quoteOf(1000, 0),
    paymentInProgress: { revision: 3, amountCents: 1000 },
  }

  it('says the payment is being processed and offers Complete payment', async () => {
    await renderOrder(processing)

    expect(screen.getByText('Your payment is being processed')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Complete payment' }),
    ).toBeEnabled()
    expect(screen.queryByText('Awaiting stock')).toBeNull()
    expect(screen.queryByText(/out of stock/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
  })

  it('never shows Awaiting stock even if the status arrives as awaiting_stock', async () => {
    await renderOrder({ ...processing, status: 'awaiting_stock' })

    expect(screen.queryByText('Awaiting stock')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Complete payment' }),
    ).toBeEnabled()
  })

  it('retries pay with the attempt revision and amount', async () => {
    const user = userEvent.setup()
    await renderOrder({
      ...processing,
      revision: 5,
      paymentInProgress: { revision: 4, amountCents: 900 },
    })
    vi.mocked(api.payOrder).mockResolvedValue({
      ...processing,
      status: 'paid',
      paidAt: '2026-10-05T12:10:00.000Z',
      paymentInProgress: null,
    })

    await user.click(screen.getByRole('button', { name: 'Complete payment' }))

    expect(api.payOrder).toHaveBeenCalledWith(42, {
      expectedRevision: 4,
      expectedTotalCents: 900,
    })
    expect(
      await screen.findByRole('heading', { name: 'Receipt' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Complete payment' }),
    ).toBeNull()
  })

  it('shows no processing message without an attempt', async () => {
    await renderOrder(base)
    expect(screen.queryByText('Your payment is being processed')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pay $30.00' })).toBeEnabled()
  })
})

describe('PatientOrderView expectedPayableLines (15.2)', () => {
  const limited: PatientOrderDetailDto = {
    ...base,
    totalCents: 1000 * 3 + 500 * 2,
    lines: [
      line(1, 1, 3, 10, 1000),
      line(2, 2, 5, 3, 500),
      line(3, 3, 2, 0, 400),
    ],
    partialPaymentQuote: quoteOf(3000 + 1500, 1000 + 800),
  }

  it('sends the displayed in-stock lines, omitting zero-quantity ones', async () => {
    const user = userEvent.setup()
    await renderOrder(limited)
    vi.mocked(api.payOrder).mockResolvedValue({
      ...limited,
      status: 'paid',
      paidAt: '2026-10-05T12:10:00.000Z',
    })

    await user.click(
      screen.getByRole('button', { name: 'Pay $45.00 for in-stock items' }),
    )

    expect(api.payOrder).toHaveBeenCalledWith(42, {
      mode: 'available',
      expectedRevision: 3,
      expectedTotalCents: 4500,
      expectedPayableLines: [
        { productId: 1, quantity: 3 },
        { productId: 2, quantity: 3 },
      ],
    })
  })

  it('does not send expectedPayableLines for a full pay', async () => {
    const user = userEvent.setup()
    await renderOrder(base)
    vi.mocked(api.payOrder).mockResolvedValue({ ...base, status: 'paid' })

    await user.click(screen.getByRole('button', { name: 'Pay $30.00' }))

    expect(api.payOrder).toHaveBeenCalledWith(42, {
      expectedRevision: 3,
      expectedTotalCents: 3000,
    })
  })
})

describe('PatientOrderView chain order (15.3)', () => {
  const blocked: PatientOrderDetailDto = {
    ...base,
    id: 42,
    blockedByOrderId: 41,
  }

  it('hides Pay and links to the unpaid parent', async () => {
    await renderOrder(blocked)

    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
    expect(screen.getByText(/Pay order/)).toHaveTextContent(
      'Pay order #41 first',
    )
    expect(screen.getByRole('link', { name: '#41' })).toHaveAttribute(
      'href',
      '/my-orders/41',
    )
  })

  it('shows Pay when the parent is paid (blockedByOrderId null)', async () => {
    await renderOrder({ ...base, blockedByOrderId: null })
    expect(screen.getByRole('button', { name: 'Pay $30.00' })).toBeEnabled()
    expect(screen.queryByText(/Pay order/)).toBeNull()
  })

  it('on 409 PRIOR_ORDER_UNPAID reloads and blocks the order', async () => {
    const user = userEvent.setup()
    await renderOrder(base)
    vi.mocked(api.payOrder).mockRejectedValueOnce(
      new api.ApiRequestError(409, 'PRIOR_ORDER_UNPAID', 'Pay order #41 first'),
    )
    vi.mocked(api.getOrder).mockResolvedValue(blocked)

    await user.click(screen.getByRole('button', { name: 'Pay $30.00' }))

    expect(await screen.findByRole('link', { name: '#41' })).toBeVisible()
    expect(screen.getByText(/Pay order/)).toHaveTextContent(
      'Pay order #41 first',
    )
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
  })

  it('falls back to priorOrderId from the error when the reload lacks it', async () => {
    const user = userEvent.setup()
    await renderOrder(base)
    vi.mocked(api.payOrder).mockRejectedValueOnce(
      new api.ApiRequestError(
        409,
        'PRIOR_ORDER_UNPAID',
        'Pay order #41 first',
        undefined,
        undefined,
        { priorOrderId: 41 } as never,
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Pay $30.00' }))

    expect(await screen.findByRole('link', { name: '#41' })).toHaveAttribute(
      'href',
      '/my-orders/41',
    )
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
  })
})
