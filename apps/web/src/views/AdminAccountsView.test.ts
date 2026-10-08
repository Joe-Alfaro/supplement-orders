import { screen, waitFor, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type {
  AdminJournalDto,
  AdminJournalPageDto,
  AdminTrialBalanceDto,
} from '@supplement-orders/domain'
import { renderWithRouter } from '../test/renderWithRouter'
import AdminAccountsView from './AdminAccountsView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getAdminAccounts: vi.fn(), listAdminJournals: vi.fn() }
})

const trialBalance: AdminTrialBalanceDto = {
  accounts: [
    {
      id: 1,
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
      providerId: null,
      debitsCents: 12000,
      creditsCents: 0,
      balanceCents: 12000,
    },
    {
      id: 2,
      code: '2100-1',
      name: 'Payable to Dr. Maya Rivera',
      type: 'liability',
      normalBalance: 'credit',
      providerId: 1,
      debitsCents: 0,
      creditsCents: 4910,
      balanceCents: 4910,
    },
    {
      id: 3,
      code: '4000',
      name: 'Product sales at wholesale cost',
      type: 'revenue',
      normalBalance: 'credit',
      providerId: null,
      debitsCents: 0,
      creditsCents: 7000,
      balanceCents: 7000,
    },
    {
      id: 4,
      code: '4100',
      name: 'Platform fee revenue',
      type: 'revenue',
      normalBalance: 'credit',
      providerId: null,
      debitsCents: 0,
      creditsCents: 90,
      balanceCents: 90,
    },
  ],
  totals: { debitsCents: 12000, creditsCents: 12000 },
}

function journal(id: number): AdminJournalDto {
  return {
    id,
    orderId: 40 + id,
    kind: 'patient_payment',
    paymentId: id,
    memo: `Payment for order #${40 + id}`,
    postedAt: '2026-10-05T12:10:00.000Z',
    patientName: 'Jordan Lee',
    providerName: 'Dr. Maya Rivera',
    postings: [
      {
        accountCode: '1000',
        accountName: 'Cash',
        debitCents: 12000,
        creditCents: null,
      },
      {
        accountCode: '4000',
        accountName: 'Product sales at wholesale cost',
        debitCents: null,
        creditCents: 12000,
      },
    ],
  }
}

function journalPage(
  items: AdminJournalDto[],
  total = items.length,
  offset = 0,
): AdminJournalPageDto {
  return { items, total, offset, limit: 25 }
}

async function renderPage() {
  return renderWithRouter(AdminAccountsView, { path: '/admin/accounts' })
}

beforeEach(() => {
  vi.mocked(api.getAdminAccounts).mockReset().mockResolvedValue(trialBalance)
  vi.mocked(api.listAdminJournals)
    .mockReset()
    .mockResolvedValue(journalPage([journal(2), journal(1)]))
})

describe('AdminAccountsView trial balance', () => {
  it('lists code, account, type, debits, credits and balance', async () => {
    await renderPage()
    const table = await screen.findByRole('table', { name: 'Trial balance' })
    ;['Code', 'Account', 'Type', 'Debits', 'Credits', 'Balance'].forEach(
      (name) =>
        expect(
          within(table).getByRole('columnheader', { name }),
        ).toBeInTheDocument(),
    )
    const payable = within(table).getByRole('row', { name: /2100-1/ })
    expect(
      within(payable).getByText('Payable to Dr. Maya Rivera'),
    ).toBeVisible()
    expect(within(payable).getByText('liability')).toBeVisible()
    expect(within(payable).getAllByText('$49.10')).toHaveLength(2)
  })

  it('shows a totals row with a visible Debits = Credits check', async () => {
    await renderPage()
    const table = await screen.findByRole('table', { name: 'Trial balance' })
    const totals = within(table).getByRole('row', { name: /Totals/ })
    expect(within(totals).getAllByText('$120.00')).toHaveLength(2)
    expect(within(totals).getByText(/Debits = Credits/)).toBeVisible()
  })

  it('flags totals that differ', async () => {
    vi.mocked(api.getAdminAccounts).mockResolvedValue({
      ...trialBalance,
      totals: { debitsCents: 12000, creditsCents: 11999 },
    })
    await renderPage()
    expect(await screen.findByText(/Debits ≠ Credits/)).toBeVisible()
  })

  it('shows loading while the trial balance is fetched', async () => {
    vi.mocked(api.getAdminAccounts).mockReturnValue(new Promise(() => {}))
    await renderPage()
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0)
    expect(screen.queryByRole('table', { name: 'Trial balance' })).toBeNull()
  })

  it('shows an error with retry', async () => {
    vi.mocked(api.getAdminAccounts).mockRejectedValueOnce(new Error('boom'))
    await renderPage()
    await screen.findByRole('button', { name: /retry/i })
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(
      await screen.findByRole('table', { name: 'Trial balance' }),
    ).toBeVisible()
    expect(api.getAdminAccounts).toHaveBeenCalledTimes(2)
  })

  it('says so when there are no accounts', async () => {
    vi.mocked(api.getAdminAccounts).mockResolvedValue({
      accounts: [],
      totals: { debitsCents: 0, creditsCents: 0 },
    })
    await renderPage()
    expect(await screen.findByText('No accounts.')).toBeVisible()
  })
})

describe('AdminAccountsView journals', () => {
  it('lists journals newest first with order, people and time', async () => {
    await renderPage()
    const table = await screen.findByRole('table', { name: 'Journals' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Payment for order #42')
    expect(rows[1]).toHaveTextContent('Payment for order #41')
    expect(rows[0]).toHaveTextContent('Jordan Lee')
    expect(rows[0]).toHaveTextContent('Dr. Maya Rivera')
    expect(within(rows[0]!).getByRole('link', { name: '#42' })).toHaveAttribute(
      'href',
      '/orders/42',
    )
  })

  it('expands a journal to show its postings, and collapses it again', async () => {
    await renderPage()
    await screen.findByRole('table', { name: 'Journals' })
    const toggle = screen.getByRole('button', {
      name: 'Show postings for journal 2',
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('table', { name: 'Journal 2 postings' }),
    ).toBeNull()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const postings = await screen.findByRole('table', {
      name: 'Journal 2 postings',
    })
    expect(within(postings).getByText('Cash')).toBeVisible()
    expect(within(postings).getByText(/Debits = Credits/)).toBeVisible()

    await userEvent.click(toggle)
    expect(
      screen.queryByRole('table', { name: 'Journal 2 postings' }),
    ).toBeNull()
  })

  it('pages through journals', async () => {
    vi.mocked(api.listAdminJournals).mockImplementation(async (query) =>
      query?.offset === 25
        ? journalPage([journal(1)], 26, 25)
        : journalPage(
            Array.from({ length: 25 }, (_, i) => journal(26 - i)),
            26,
          ),
    )
    await renderPage()
    await screen.findByText('Showing 1–25 of 26')
    await userEvent.click(screen.getByRole('button', { name: /next page/i }))
    await screen.findByText('Showing 26–26 of 26')
    expect(api.listAdminJournals).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25, limit: 25 }),
    )
  })

  it('says so when there are no journals yet', async () => {
    vi.mocked(api.listAdminJournals).mockResolvedValue(journalPage([]))
    await renderPage()
    expect(await screen.findByText('No journals yet.')).toBeVisible()
  })

  it('shows a journal error with retry that leaves the trial balance', async () => {
    vi.mocked(api.listAdminJournals).mockRejectedValueOnce(new Error('boom'))
    await renderPage()
    await screen.findByRole('table', { name: 'Trial balance' })
    const retry = await screen.findByRole('button', { name: /retry/i })
    await userEvent.click(retry)
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Journals' })).toBeVisible(),
    )
  })
})
