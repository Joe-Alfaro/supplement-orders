import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { AdminPaymentAttemptDto } from '@supplement-orders/domain'
import { expectNoAxeViolations } from '../a11y/expectNoAxeViolations'
import { renderWithRouter } from '../test/renderWithRouter'
import AdminAccountsView from './AdminAccountsView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getAdminAccounts: vi.fn(),
    listAdminJournals: vi.fn(),
    listUnresolvedPaymentAttempts: vi.fn(),
    reconcilePaymentAttempt: vi.fn(),
    refundPaymentAttempt: vi.fn(),
  }
})

const attempt: AdminPaymentAttemptDto = {
  id: 9,
  orderId: 42,
  providerName: 'Dr. Maya Rivera',
  amountCents: 3000,
  status: 'pending',
  hasPayment: false,
  createdAt: '2026-10-08T10:00:00.000Z',
  ageSeconds: 7200,
  reconciledAt: null,
  gatewayReference: null,
  refundedAt: null,
}

beforeEach(() => {
  vi.mocked(api.getAdminAccounts)
    .mockReset()
    .mockResolvedValue({
      accounts: [],
      totals: { debitsCents: 0, creditsCents: 0 },
    })
  vi.mocked(api.listAdminJournals)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 25 })
  vi.mocked(api.listUnresolvedPaymentAttempts)
    .mockReset()
    .mockResolvedValue([attempt])
  vi.mocked(api.reconcilePaymentAttempt).mockReset()
  vi.mocked(api.refundPaymentAttempt).mockReset()
})

async function panel() {
  await renderWithRouter(AdminAccountsView, { path: '/admin/accounts' })
  return screen.findByRole('table', { name: 'Payments needing attention' })
}

describe('Payments needing attention (18.2)', () => {
  it('lists order, provider, amount, status and age, with no patient data', async () => {
    const table = await panel()
    const row = within(table).getByRole('row', { name: /Order #42/ })

    expect(row).toHaveTextContent('Dr. Maya Rivera')
    expect(row).toHaveTextContent('$30.00')
    expect(row).toHaveTextContent('Pending')
    expect(row).toHaveTextContent('2 hours')
    expect(row).not.toHaveTextContent(/Jordan|Alder/)
  })

  it('has no axe violations', async () => {
    await panel()
    // Scan the panel itself: the page <h1> sits outside the App layout's <main>.
    await expectNoAxeViolations(
      screen.getByRole('region', {
        name: 'Payments needing attention',
      }),
    )
  })

  it('says so when nothing needs attention', async () => {
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([])
    await renderWithRouter(AdminAccountsView, { path: '/admin/accounts' })

    expect(await screen.findByText('No payments need attention.')).toBeVisible()
  })

  it('confirms before reconciling, then toasts the result and refreshes', async () => {
    const user = userEvent.setup()
    vi.mocked(api.reconcilePaymentAttempt).mockResolvedValue({
      outcome: 'finalized',
      attempt,
    })
    const table = await panel()
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([])

    await user.click(
      within(table).getByRole('button', { name: 'Reconcile order 42' }),
    )
    expect(api.reconcilePaymentAttempt).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog', { name: 'Reconcile' })
    await user.click(within(dialog).getByRole('button', { name: 'Reconcile' }))

    expect(api.reconcilePaymentAttempt).toHaveBeenCalledWith(9)
    expect(
      await screen.findByText('Order #42 reconciled: payment recorded'),
    ).toBeVisible()
    expect(await screen.findByText('No payments need attention.')).toBeVisible()
  })

  it('does nothing when the confirmation is declined', async () => {
    const user = userEvent.setup()
    const table = await panel()

    await user.click(
      within(table).getByRole('button', { name: 'Reconcile order 42' }),
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Reconcile' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(api.reconcilePaymentAttempt).not.toHaveBeenCalled()
  })

  it('explains a too-early reconcile and keeps the row', async () => {
    const user = userEvent.setup()
    vi.mocked(api.reconcilePaymentAttempt).mockRejectedValue(
      new api.ApiRequestError(
        409,
        'RECONCILE_TOO_EARLY',
        'Too early to reconcile',
      ),
    )
    const table = await panel()

    await user.click(
      within(table).getByRole('button', { name: 'Reconcile order 42' }),
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Reconcile' })
    await user.click(within(dialog).getByRole('button', { name: 'Reconcile' }))

    expect(await screen.findByText('Too early to reconcile')).toBeVisible()
    expect(
      within(table).getByRole('button', { name: 'Reconcile order 42' }),
    ).toBeEnabled()
  })
})

describe('Late successes and refunds (19.1)', () => {
  const lateSuccess: AdminPaymentAttemptDto = {
    ...attempt,
    id: 11,
    status: 'late_success',
    amountCents: 4500,
  }
  const refundRequired: AdminPaymentAttemptDto = {
    ...attempt,
    id: 12,
    orderId: 43,
    status: 'refund_required',
    amountCents: 5000,
  }

  it('shows a late success as a charge to reconcile, with the Reconcile action', async () => {
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([
      lateSuccess,
    ])
    const table = await panel()
    const row = within(table).getByRole('row', { name: /Order #42/ })

    expect(row).toHaveTextContent('Charged late')
    expect(row).toHaveTextContent('$45.00')
    expect(
      within(row).getByRole('button', { name: 'Reconcile order 42' }),
    ).toBeEnabled()
  })

  it('shows "Charged twice — refund $X" with Mark refunded, and no patient data', async () => {
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([
      refundRequired,
    ])
    const table = await panel()
    const row = within(table).getByRole('row', { name: /Order #43/ })

    expect(row).toHaveTextContent('Charged twice — refund $50.00')
    expect(row).not.toHaveTextContent(/Jordan|Alder/)
    expect(
      within(row).queryByRole('button', { name: /^Reconcile/ }),
    ).not.toBeInTheDocument()
    expect(
      within(row).getByRole('button', { name: 'Mark order 43 refunded' }),
    ).toBeEnabled()
  })

  it('confirms before marking refunded, then toasts and refreshes', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([
      refundRequired,
    ])
    vi.mocked(api.refundPaymentAttempt).mockResolvedValue({
      outcome: 'refunded',
      attempt: { ...refundRequired, refundedAt: '2026-10-08T12:00:00.000Z' },
    })
    const table = await panel()
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([])

    await user.click(
      within(table).getByRole('button', { name: 'Mark order 43 refunded' }),
    )
    expect(api.refundPaymentAttempt).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Mark refunded',
    })
    await user.click(
      within(dialog).getByRole('button', { name: 'Mark refunded' }),
    )

    expect(api.refundPaymentAttempt).toHaveBeenCalledWith(12)
    expect(await screen.findByText('Order #43 marked refunded')).toBeVisible()
    expect(await screen.findByText('No payments need attention.')).toBeVisible()
  })

  it('does nothing when the refund confirmation is declined', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([
      refundRequired,
    ])
    const table = await panel()

    await user.click(
      within(table).getByRole('button', { name: 'Mark order 43 refunded' }),
    )
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Mark refunded',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(api.refundPaymentAttempt).not.toHaveBeenCalled()
  })

  it('shows a failed refund and keeps the row', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listUnresolvedPaymentAttempts).mockResolvedValue([
      refundRequired,
    ])
    vi.mocked(api.refundPaymentAttempt).mockRejectedValue(
      new api.ApiRequestError(500, 'INTERNAL', 'Refund failed'),
    )
    const table = await panel()

    await user.click(
      within(table).getByRole('button', { name: 'Mark order 43 refunded' }),
    )
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Mark refunded',
    })
    await user.click(
      within(dialog).getByRole('button', { name: 'Mark refunded' }),
    )

    expect(await screen.findByText('Refund failed')).toBeVisible()
    expect(
      within(table).getByRole('button', { name: 'Mark order 43 refunded' }),
    ).toBeEnabled()
  })
})
