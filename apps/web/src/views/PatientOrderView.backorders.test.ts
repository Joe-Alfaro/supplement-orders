import type { PatientOrderDetailDto } from '@supplement-orders/domain'
import { screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { expectNoAxeViolations } from '../a11y/expectNoAxeViolations'
import { renderWithRouter } from '../test/renderWithRouter'
import PatientOrderView from './PatientOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getOrder: vi.fn(), payOrder: vi.fn() }
})

/** The server's quote shape: an empty side is zeros. */
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

/** Fills the per-line fields the API adds (lineId, payable and short counts). */
function withStock(
  line: Omit<
    PatientOrderDetailDto['lines'][number],
    'lineId' | 'payableQuantity' | 'shortQuantity'
  >,
  index: number,
): PatientOrderDetailDto['lines'][number] {
  const available = line.availableQuantity ?? line.quantity
  const payable = Math.min(line.quantity, available)
  return {
    ...line,
    lineId: index + 1,
    payableQuantity: payable,
    shortQuantity: line.quantity - payable,
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
  patientAddress: '214 Alder St, Portland, OR 97205',
  totalCents: 12000 + 5 * 1000 + 2 * 500,
  lines: [
    {
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 3,
      unitPriceCents: 4000,
      lineTotalCents: 12000,
      availableQuantity: 10,
    },
    {
      productId: 2,
      productName: 'Magnesium',
      sku: 'MAG',
      quantity: 5,
      unitPriceCents: 1000,
      lineTotalCents: 5000,
      availableQuantity: 3,
    },
    {
      productId: 3,
      productName: 'Zinc',
      sku: 'ZINC',
      quantity: 2,
      unitPriceCents: 500,
      lineTotalCents: 1000,
      availableQuantity: 0,
    },
  ].map(withStock),
  payment: null,
  splitFromOrderId: null,
  backorderOrderId: null,
  blockedByOrderId: null,
  partialPaymentQuote: quoteOf(15000, 3000),
  paymentInProgress: null,
  backorderStatus: null,
}

const limited = base
const awaiting: PatientOrderDetailDto = {
  ...base,
  status: 'awaiting_stock',
  partialPaymentQuote: quoteOf(0, 18000),
  lines: base.lines.map((line, index) =>
    withStock({ ...line, availableQuantity: 0 }, index),
  ),
}

async function renderOrder(order: PatientOrderDetailDto = limited) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  const view = await renderWithRouter(PatientOrderView, {
    path: '/my-orders/42',
    props: { orderId: '42' },
  })
  await screen.findByRole('heading', { name: /Order #42/ })
  return view
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.payOrder).mockReset()
})

describe('PatientOrderView with limited stock', () => {
  it('shows nothing extra when everything is in stock', async () => {
    await renderOrder({
      ...base,
      partialPaymentQuote: quoteOf(18000, 0),
      lines: base.lines.map((line, index) =>
        withStock({ ...line, availableQuantity: 99 }, index),
      ),
    })
    expect(screen.queryByText(/limited stock/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay $180.00' })).toBeEnabled()
  })

  it('shows a banner, per-line availability, both totals and the partial-pay button', async () => {
    await renderOrder()

    expect(
      screen.getByText('Some items have limited stock.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Only 3 of 5 in stock')).toBeInTheDocument()
    expect(screen.getByText('Out of stock')).toBeInTheDocument()
    expect(screen.getByText(/Pay now \(in stock\):/)).toHaveTextContent(
      '$150.00',
    )
    expect(screen.getByText(/Back-order \(pay later\):/)).toHaveTextContent(
      '$30.00',
    )
    expect(
      screen.getByText(
        "The remaining items will be saved as a separate order you can pay when they're back in stock.",
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Pay $180.00' }),
    ).not.toBeInTheDocument()
  })

  it('pays mode available with the quoted in-stock total', async () => {
    const user = userEvent.setup()
    await renderOrder()
    vi.mocked(api.payOrder).mockResolvedValue({
      ...base,
      status: 'paid',
      revision: 4,
      totalCents: 15000,
      paidAt: '2026-10-05T12:10:00.000Z',
      payment: {
        id: 5,
        amountCents: 15000,
        reference: 'fake_ch_1',
        createdAt: '2026-10-05T12:10:00.000Z',
      },
      backorderOrderId: 77,
    })

    await user.click(
      screen.getByRole('button', { name: 'Pay $150.00 for in-stock items' }),
    )

    expect(api.payOrder).toHaveBeenCalledWith(42, {
      mode: 'available',
      expectedPayableLines: [
        { productId: 1, quantity: 3 },
        { productId: 2, quantity: 3 },
      ],
      expectedRevision: 3,
      expectedTotalCents: 15000,
    })
    const links = await screen.findAllByRole('link', { name: '#77' })
    links.forEach((link) =>
      expect(link).toHaveAttribute('href', '/my-orders/77'),
    )
    expect(
      screen.getByText(/Remaining items moved to order/),
    ).toBeInTheDocument()
  })

  it('on a stale quote (409) refreshes, explains, and waits for a new click', async () => {
    const user = userEvent.setup()
    await renderOrder()
    vi.mocked(api.payOrder).mockRejectedValueOnce(
      new api.ApiRequestError(409, 'ORDER_CHANGED', 'Order changed'),
    )
    vi.mocked(api.getOrder).mockResolvedValue({
      ...base,
      revision: 4,
      totalCents: 18000,
      partialPaymentQuote: quoteOf(13000, 5000),
      lines: base.lines.map((line, index) =>
        withStock(
          {
            ...line,
            availableQuantity:
              line.productId === 2 ? 1 : line.availableQuantity,
          },
          index,
        ),
      ),
    })

    await user.click(
      screen.getByRole('button', { name: 'Pay $150.00 for in-stock items' }),
    )

    expect(
      await screen.findByText(
        'Stock changed; please review the updated amounts.',
      ),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('button', {
        name: 'Pay $130.00 for in-stock items',
      }),
    ).toBeEnabled()
    expect(api.payOrder).toHaveBeenCalledTimes(1)
  })

  it('has no axe violations', async () => {
    const { container } = await renderOrder()
    await expectNoAxeViolations(container)
  })
})

describe('PatientOrderView awaiting stock', () => {
  it('shows the tag and message, and no Pay button', async () => {
    await renderOrder(awaiting)

    expect(screen.getAllByText('Awaiting stock').length).toBeGreaterThan(0)
    expect(
      screen.getByText(
        "These items are out of stock. You'll be able to pay once they're back in stock.",
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Pay/ }),
    ).not.toBeInTheDocument()
  })
})

describe('PatientOrderView back-order links', () => {
  it('links a back-order to its original', async () => {
    await renderOrder({ ...awaiting, splitFromOrderId: 41 })
    expect(screen.getByRole('link', { name: '#41' })).toHaveAttribute(
      'href',
      '/my-orders/41',
    )
    expect(screen.getByText(/Back-order of order/)).toBeInTheDocument()
  })

  it('links a partially fulfilled original to its back-order', async () => {
    await renderOrder({
      ...base,
      status: 'paid',
      paidAt: '2026-10-05T12:10:00.000Z',
      backorderOrderId: 77,
    })
    expect(screen.getAllByRole('link', { name: '#77' })[0]).toHaveAttribute(
      'href',
      '/my-orders/77',
    )
    expect(
      screen.getByText(/Partially fulfilled: remaining items moved to order/),
    ).toBeInTheDocument()
  })
})
