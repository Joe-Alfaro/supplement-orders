import type { ProviderOrderDetailDto } from '@supplement-orders/domain'
import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import { clearNoticeUnlessOn, notice } from '../user'
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

const paid: ProviderOrderDetailDto = {
  id: 42,
  view: 'provider',
  revision: 1,
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
  revision: 0,
}

const cancelled: ProviderOrderDetailDto = {
  ...pending,
  status: 'cancelled',
  cancelledAt: '2026-10-06T09:30:00.000Z',
}

const ACTIONS = ['Delete draft', 'Cancel order', 'Reopen as draft']

async function openOrder(order: ProviderOrderDetailDto) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  const { router } = await renderWithRouter(ProviderOrderView, {
    path: `/orders/${order.id}`,
    props: { orderId: String(order.id) },
  })
  await screen.findByRole('heading', { name: /Order #42/ })
  return { router }
}

function confirmDialog(name: string) {
  return screen.findByRole('alertdialog', { name })
}

function expectNoDialog(name: string) {
  return vi.waitFor(() =>
    expect(screen.queryByRole('alertdialog', { name })).not.toBeInTheDocument(),
  )
}

async function confirmAction(action: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: action }))
  const dialog = await confirmDialog(action)
  await user.click(within(dialog).getByRole('button', { name: action }))
}

function conflict(message: string) {
  return new api.ApiRequestError(409, 'ORDER_NOT_DRAFT', message)
}

beforeEach(() => {
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.cancelOrder).mockReset()
  vi.mocked(api.deleteOrder).mockReset()
  vi.mocked(api.reopenOrder).mockReset()
  clearNoticeUnlessOn('__reset__')
})

describe('ProviderOrderView actions by status', () => {
  it.each([
    ['draft', draft, 'Delete draft'],
    ['pending_payment', pending, 'Cancel order'],
    ['cancelled', cancelled, 'Reopen as draft'],
  ])("offers only %s's action", async (_status, order, action) => {
    await openOrder(order)

    expect(screen.getByRole('button', { name: action })).toBeInTheDocument()
    ACTIONS.filter((other) => other !== action).forEach((other) => {
      expect(
        screen.queryByRole('button', { name: other }),
      ).not.toBeInTheDocument()
    })
  })

  it('offers no action on a paid order', async () => {
    await openOrder(paid)

    ACTIONS.forEach((action) => {
      expect(
        screen.queryByRole('button', { name: action }),
      ).not.toBeInTheDocument()
    })
  })
})

describe('ProviderOrderView cancel', () => {
  it('confirms, cancels once, then shows Cancelled with only Reopen left', async () => {
    const user = userEvent.setup()
    vi.mocked(api.cancelOrder).mockResolvedValue(cancelled)
    await openOrder(pending)

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    const dialog = await confirmDialog('Cancel order')
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
    await expectNoDialog('Cancel order')
    expect(
      screen.queryByRole('button', { name: 'Cancel order' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Waiting for patient payment.'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reopen as draft' }),
    ).toBeInTheDocument()
  })

  it('does nothing on Keep order', async () => {
    const user = userEvent.setup()
    await openOrder(pending)

    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    await user.click(
      within(await confirmDialog('Cancel order')).getByRole('button', {
        name: 'Keep order',
      }),
    )

    await expectNoDialog('Cancel order')
    expect(api.cancelOrder).not.toHaveBeenCalled()
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
  })

  it('shows a 409 in the error banner and re-fetches the order', async () => {
    const paidMeanwhile = 'This order was paid and can no longer be cancelled'
    vi.mocked(api.cancelOrder).mockRejectedValue(
      new api.ApiRequestError(409, 'ORDER_NOT_CANCELLABLE', paidMeanwhile),
    )
    await openOrder(pending)
    vi.mocked(api.getOrder).mockResolvedValue(paid)

    await confirmAction('Cancel order')

    expect(await screen.findByText(paidMeanwhile)).toBeInTheDocument()
    expect(await screen.findByText('Total of entries')).toBeInTheDocument()
    expect(api.getOrder).toHaveBeenCalledTimes(2)
    expect(screen.getByText(paidMeanwhile)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Cancel order' }),
    ).not.toBeInTheDocument()
  })
})

describe('ProviderOrderView delete draft', () => {
  it('confirms, deletes once, and returns to the patient with a notice', async () => {
    const user = userEvent.setup()
    vi.mocked(api.deleteOrder).mockResolvedValue(undefined)
    const { router } = await openOrder(draft)

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    const dialog = await confirmDialog('Delete draft')
    expect(dialog).toHaveTextContent(
      "Delete draft order #42 for Jordan Lee? This can't be undone.",
    )
    expect(
      within(dialog).getByRole('button', { name: 'Keep draft' }),
    ).toHaveFocus()
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    )

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients/7'),
    )
    expect(api.deleteOrder).toHaveBeenCalledTimes(1)
    expect(api.deleteOrder).toHaveBeenCalledWith(42)
    // The notice renders in App's header region, outside this view.
    expect(notice.value).toEqual({
      message: 'Draft deleted',
      path: '/patients/7',
    })
  })

  it('does nothing on Keep draft', async () => {
    const user = userEvent.setup()
    const { router } = await openOrder(draft)

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    await user.click(
      within(await confirmDialog('Delete draft')).getByRole('button', {
        name: 'Keep draft',
      }),
    )

    await expectNoDialog('Delete draft')
    expect(api.deleteOrder).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/orders/42')
    expect(screen.getByRole('link', { name: 'Edit draft' })).toBeInTheDocument()
  })

  it('shows a 409 in the error banner and re-fetches the order', async () => {
    const sentMeanwhile = 'Only a draft can be deleted'
    vi.mocked(api.deleteOrder).mockRejectedValue(conflict(sentMeanwhile))
    const { router } = await openOrder(draft)
    vi.mocked(api.getOrder).mockResolvedValue(pending)

    await confirmAction('Delete draft')

    expect(await screen.findByText(sentMeanwhile)).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
    expect(api.getOrder).toHaveBeenCalledTimes(2)
    expect(router.currentRoute.value.path).toBe('/orders/42')
    expect(notice.value).toBeNull()
  })
})

describe('ProviderOrderView reopen', () => {
  it('confirms, reopens once, and opens the builder for that order', async () => {
    const user = userEvent.setup()
    vi.mocked(api.reopenOrder).mockResolvedValue({
      ...draft,
      cancelledAt: null,
    })
    const { router } = await openOrder(cancelled)

    await user.click(screen.getByRole('button', { name: 'Reopen as draft' }))
    const dialog = await confirmDialog('Reopen as draft')
    expect(dialog).toHaveTextContent(
      'Reopen order #42 as a draft? You can edit it and send it again.',
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Reopen as draft' }),
    )

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe(
        '/patients/7/orders/new?orderId=42',
      ),
    )
    expect(api.reopenOrder).toHaveBeenCalledTimes(1)
    expect(api.reopenOrder).toHaveBeenCalledWith(42)
  })

  it('does nothing on Keep cancelled', async () => {
    const user = userEvent.setup()
    const { router } = await openOrder(cancelled)

    await user.click(screen.getByRole('button', { name: 'Reopen as draft' }))
    await user.click(
      within(await confirmDialog('Reopen as draft')).getByRole('button', {
        name: 'Keep cancelled',
      }),
    )

    await expectNoDialog('Reopen as draft')
    expect(api.reopenOrder).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/orders/42')
  })

  it('shows a 409 in the error banner and re-fetches the order', async () => {
    const reopenedElsewhere = 'Only a cancelled order can be reopened'
    vi.mocked(api.reopenOrder).mockRejectedValue(conflict(reopenedElsewhere))
    const { router } = await openOrder(cancelled)
    vi.mocked(api.getOrder).mockResolvedValue(draft)

    await confirmAction('Reopen as draft')

    expect(await screen.findByText(reopenedElsewhere)).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Delete draft' }),
    ).toBeInTheDocument()
    expect(api.getOrder).toHaveBeenCalledTimes(2)
    expect(router.currentRoute.value.path).toBe('/orders/42')
  })

  it('shows the reconciliation message in the error banner when an action is blocked', async () => {
    const user = userEvent.setup()
    const reconciling =
      'A payment for this order is being finalized. Try again shortly or contact support.'
    const pending: ProviderOrderDetailDto = {
      ...paid,
      status: 'pending_payment',
      paidAt: null,
      payment: null,
      ledger: [],
    }
    vi.mocked(api.getOrder).mockResolvedValue(pending)
    vi.mocked(api.cancelOrder).mockRejectedValue(
      new api.ApiRequestError(409, 'PAYMENT_NEEDS_RECONCILIATION', reconciling),
    )
    await renderWithRouter(ProviderOrderView, {
      path: '/orders/42',
      props: { orderId: '42' },
    })

    await user.click(
      await screen.findByRole('button', { name: 'Cancel order' }),
    )
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Cancel order',
    })
    await user.click(
      within(dialog).getByRole('button', { name: 'Cancel order' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(reconciling)
    // The order is re-read and is still awaiting payment, not cancelled.
    expect(api.getOrder).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument()
  })
})
