import { render, screen, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { computeSplit } from '../money'
import SplitSummary from './SplitSummary.vue'

function rowValue(label: string) {
  const header = screen.getByRole('rowheader', { name: label })
  const row = header.closest('tr')
  if (!row) throw new Error(`No row for ${label}`)
  return within(row).getByRole('cell').textContent
}

describe('SplitSummary', () => {
  it('renders the exact figures from computeSplit', () => {
    // Subtotal $120.00, COGS $70.00 -> fee $0.90, patient pays $120.90, margin $50.00
    const split = computeSplit([
      { quantity: 2, unitPriceCents: 4000, unitCogsCents: 2500 },
      { quantity: 1, unitPriceCents: 4000, unitCogsCents: 2000 },
    ])
    render(SplitSummary, { props: { split } })

    expect(rowValue('Subtotal')).toBe('$120.00')
    expect(rowValue('Platform fee (0.75%)')).toBe('$0.90')
    expect(rowValue('Patient pays')).toBe('$120.90')
    expect(rowValue('Wholesale cost')).toBe('$70.00')
    expect(rowValue('Your margin')).toBe('$50.00')
    expect(rowValue('Platform fee')).toBe('$0.90')
  })
})
