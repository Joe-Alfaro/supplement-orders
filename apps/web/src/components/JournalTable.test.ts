import { render, screen, within } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import { describe, expect, it } from 'vitest'
import type { JournalPostingDto } from '@supplement-orders/domain'
import { primeVueOptions } from '../primevue'
import JournalTable from './JournalTable.vue'

const postings: JournalPostingDto[] = [
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
    creditCents: 7000,
  },
  {
    accountCode: '2100-1',
    accountName: 'Payable to Dr. Maya Rivera',
    debitCents: null,
    creditCents: 4910,
  },
  {
    accountCode: '4100',
    accountName: 'Platform fee revenue',
    debitCents: null,
    creditCents: 90,
  },
]

function renderTable(rows: JournalPostingDto[]) {
  return render(JournalTable, {
    props: { postings: rows },
    global: { plugins: [[PrimeVue, primeVueOptions]] },
  })
}

describe('JournalTable', () => {
  it('shows each account with its debit or credit', () => {
    renderTable(postings)
    const table = screen.getByRole('table', { name: 'Journal' })
    const cash = within(table).getByRole('row', { name: /Cash/ })
    expect(within(cash).getByText('$120.00')).toBeInTheDocument()
    const payable = within(table).getByRole('row', {
      name: /Payable to Dr\. Maya Rivera/,
    })
    expect(within(payable).getByText('$49.10')).toBeInTheDocument()
    expect(
      within(table).getByRole('columnheader', { name: 'Account' }),
    ).toBeInTheDocument()
  })

  it('totals debits and credits and says they are equal', () => {
    renderTable(postings)
    const totals = screen.getByRole('row', { name: /Totals/ })
    expect(within(totals).getAllByText('$120.00')).toHaveLength(2)
    expect(within(totals).getByText(/Debits = Credits/)).toBeInTheDocument()
  })

  it('flags a journal that does not balance', () => {
    renderTable(postings.slice(0, 3))
    expect(screen.getByText(/Debits ≠ Credits/)).toBeInTheDocument()
    expect(screen.queryByText(/Debits = Credits/)).not.toBeInTheDocument()
  })
})
