import { render, screen, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { computeSplit } from '../money'
import SplitSummary from './SplitSummary.vue'

function rowValue(label: string | RegExp) {
  const row = screen.getByRole('row', { name: label })
  return within(row).getByRole('cell')
}

describe('SplitSummary', () => {
  it('renders the exact figures from computeSplit', () => {
    // Patient pays the $120.00 subtotal; the $0.90 fee comes out of the $50.00 markup.
    const split = computeSplit([
      { quantity: 2, unitPriceCents: 4000, unitCogsCents: 2500 },
      { quantity: 1, unitPriceCents: 4000, unitCogsCents: 2000 },
    ])
    render(SplitSummary, { props: { split } })

    expect(rowValue(/^Patient pays/)).toHaveTextContent('$120.00')
    expect(rowValue(/^Wholesale cost/)).toHaveTextContent('$70.00')
    expect(rowValue(/^Processing fee \(0\.75%\)/)).toHaveTextContent('$0.90')
    expect(
      screen.getByRole('rowheader', { name: /Processing fee/ }),
    ).toHaveTextContent('calculated on the order total')
    expect(rowValue(/^Your margin/)).toHaveTextContent('$49.10')
    expect(
      screen.getAllByRole('rowheader').map((header) => header.textContent),
    ).toEqual([
      'Patient pays',
      'Wholesale cost',
      expect.stringMatching(
        /^\s*Processing fee \(0\.75%\)\s+calculated on the order total\s*$/,
      ),
      'Your margin',
    ])
  })
})
