import { screen, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { PaymentAttemptDto } from '../api/rev18'
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
  }
})

const attempt: PaymentAttemptDto = {
  id: 9,
  orderId: 42,
  providerName: 'Dr. Maya Rivera',
  amountCents: 3000,
  status: 'pending',
  ageSeconds: 7200,
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
      id: 9,
      outcome: 'succeeded',
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
        'RECONCILE_TOO_EARLY' as never,
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
