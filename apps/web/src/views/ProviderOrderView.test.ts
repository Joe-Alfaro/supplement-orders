import type { ProviderOrderDetailDto } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import ProviderOrderView from './ProviderOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getOrder: vi.fn(), cancelOrder: vi.fn() }
})

const paid: ProviderOrderDetailDto = {
  id: 42,
  view: 'provider',
  status: 'paid',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: '2026-10-05T12:10:00.000Z',
  cancelledAt: null,
  split: {
    subtotalCents: 12000,
    platformFeeCents: 90,
    totalCents: 12000,
    cogsCents: 7000,
    providerMarginCents: 4910,
  },
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St',
  lines: [
    {
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 3,
      unitPriceCents: 4000,
      lineTotalCents: 12000,
      unitCogsCents: 2333,
      markupBps: 4168,
      minUnitPriceCents: 2351,
      stockQuantity: 7,
    },
  ],
  payment: {
    id: 5,
    amountCents: 12000,
    reference: 'fake_ch_1',
    createdAt: '2026-10-05T12:10:00.000Z',
  },
  ledger: [
    {
      id: 1,
      type: 'cogs',
      amountCents: 7000,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
    {
      id: 2,
      type: 'provider_margin',
      amountCents: 4910,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
    {
      id: 3,
      type: 'platform_fee',
      amountCents: 90,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
  ],
}

describe('ProviderOrderView', () => {
  it('labels the fee "Processing fee" in the split and ledger, and checks the total', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(paid)
    await renderWithRouter(ProviderOrderView, {
      path: '/orders/42',
      props: { orderId: '42' },
    })
    await screen.findByText('Total of entries')
    expect(
      screen.getByRole('table', { name: 'Order lines' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Ledger' })).toBeInTheDocument()

    expect(
      screen.getByRole('cell', { name: 'Processing fee' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Equals amount paid/)).toBeInTheDocument()
    expect(
      screen.getByRole('rowheader', { name: /^Processing fee \(0\.75%\)/ }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Platform fee/i)
  })
})

const pending: ProviderOrderDetailDto = {
  ...paid,
  status: 'pending_payment',
  paidAt: null,
  payment: null,
  ledger: [],
}

const draft: ProviderOrderDetailDto = {
  ...pending,
  status: 'draft',
  sentAt: null,
}

const cancelled: ProviderOrderDetailDto = {
  ...pending,
  status: 'cancelled',
  cancelledAt: '2026-10-06T09:30:00.000Z',
}

async function openOrder(order: ProviderOrderDetailDto) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  await renderWithRouter(ProviderOrderView, {
    path: `/orders/${order.id}`,
    props: { orderId: String(order.id) },
  })
  await screen.findByRole('heading', { name: /Order #42/ })
}

function confirmDialog() {
  return screen.findByRole('alertdialog', { name: 'Cancel order' })
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.cancelOrder).mockReset()
})

describe('ProviderOrderView cancel', () => {
  it.each([
    ['draft', draft],
    ['pending_payment', pending],
  ])('offers Cancel order on a %s order', async (_status, order) => {
    await openOrder(order)

    expect(
      screen.getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
  })

  it.each([
    ['paid', paid],
    ['cancelled', cancelled],
  ])('has no Cancel order on a %s order', async (_status, order) => {
    await openOrder(order)

    expect(
      screen.queryByRole('button', { name: 'Cancel order' }),
    ).not.toBeInTheDocument()
  })

  it('confirms, cancels once, then shows Cancelled with no actions', async () => {
    const user = userEvent.setup()
    vi.mocked(api.cancelOrder).mockResolvedValue(cancelled)
    await openOrder(pending)

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    const dialog = await confirmDialog()
    expect(dialog).toHaveTextContent(
      'Cancel order #42 for Jordan Lee? The patient will no longer be able to pay it.',
    )
    // A destructive confirm starts on the safe choice.
    expect(
      within(dialog).getByRole('button', { name: 'Keep order' }),
    ).toHaveFocus()
    await user.click(
      within(dialog).getByRole('button', { name: 'Cancel order' }),
    )

    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
    expect(api.cancelOrder).toHaveBeenCalledTimes(1)
    expect(api.cancelOrder).toHaveBeenCalledWith(42)
    expect(screen.getByText('Cancelled at')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Cancel order' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Waiting for patient payment.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('alertdialog', { name: 'Cancel order' }),
    ).not.toBeInTheDocument()
  })

  it('hides Edit draft once a draft is cancelled', async () => {
    const user = userEvent.setup()
    vi.mocked(api.cancelOrder).mockResolvedValue({
      ...cancelled,
      sentAt: null,
    })
    await openOrder(draft)
    expect(screen.getByRole('link', { name: 'Edit draft' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    await user.click(
      within(await confirmDialog()).getByRole('button', {
        name: 'Cancel order',
      }),
    )

    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Edit draft' }),
    ).not.toBeInTheDocument()
  })

  it('does nothing on Keep order', async () => {
    const user = userEvent.setup()
    await openOrder(pending)

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    await user.click(
      within(await confirmDialog()).getByRole('button', { name: 'Keep order' }),
    )

    await vi.waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: 'Cancel order' }),
      ).not.toBeInTheDocument(),
    )
    expect(api.cancelOrder).not.toHaveBeenCalled()
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
  })

  it('shows a 409 in the error banner and re-fetches the order', async () => {
    const user = userEvent.setup()
    const paidMeanwhile = 'This order was paid and can no longer be cancelled'
    vi.mocked(api.cancelOrder).mockRejectedValue(
      new api.ApiRequestError(409, 'ORDER_NOT_CANCELLABLE', paidMeanwhile),
    )
    await openOrder(pending)
    vi.mocked(api.getOrder).mockResolvedValue(paid)

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    await user.click(
      within(await confirmDialog()).getByRole('button', {
        name: 'Cancel order',
      }),
    )

    expect(await screen.findByText(paidMeanwhile)).toBeInTheDocument()
    expect(await screen.findByText('Total of entries')).toBeInTheDocument()
    expect(api.getOrder).toHaveBeenCalledTimes(2)
    expect(screen.getByText(paidMeanwhile)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Cancel order' }),
    ).not.toBeInTheDocument()
  })
})
