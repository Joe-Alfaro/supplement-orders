import { render, screen, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { computeSplit } from '../money'
import SplitSummary from './SplitSummary.vue'

function rowValue(label: string | RegExp) {
  const header = screen.getByRole('rowheader', { name: label })
  const row = header.closest('tr')
  if (!row) throw new Error(`No row for ${label}`)
  return within(row).getByRole('cell').textContent
}

describe('SplitSummary', () => {
  it('renders the exact figures from computeSplit', () => {
    // Patient pays the $120.00 subtotal; the $0.90 fee comes out of the $50.00 markup.
    const split = computeSplit([
      { quantity: 2, unitPriceCents: 4000, unitCogsCents: 2500 },
      { quantity: 1, unitPriceCents: 4000, unitCogsCents: 2000 },
    ])
    render(SplitSummary, { props: { split } })

    expect(rowValue('Patient pays')).toBe('$120.00')
    expect(rowValue('Wholesale cost')).toBe('$70.00')
    expect(rowValue(/^Processing fee \(0\.75%\)/)).toBe('$0.90')
    expect(
      screen.getByRole('rowheader', { name: /Processing fee/ }).textContent,
    ).toContain('calculated on the order total')
    expect(rowValue('Your margin')).toBe('$49.10')
    expect(
      screen
        .getAllByRole('row')
        .map((row) =>
          row.querySelector('th')?.textContent?.replace(/\s+/g, ' ').trim(),
        ),
    ).toEqual([
      'Patient pays',
      'Wholesale cost',
      'Processing fee (0.75%) calculated on the order total',
      'Your margin',
    ])
  })
})
