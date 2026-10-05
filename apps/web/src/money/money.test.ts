import { describe, expect, it } from 'vitest'
import {
  formatBps,
  formatCents,
  parseDollarsToCents,
  parsePercentToBps,
} from './index'

describe('money edges', () => {
  it('formats cents with two decimals, separators, and a leading sign', () => {
    expect(formatCents(12090)).toBe('$120.90')
    expect(formatCents(123456789)).toBe('$1,234,567.89')
    expect(formatCents(-500)).toBe('-$5.00')
  })

  it('parses dollar strings to integer cents', () => {
    expect(parseDollarsToCents('120.9')).toEqual({ ok: true, cents: 12090 })
    expect(parseDollarsToCents('$1,234.5')).toEqual({ ok: true, cents: 123450 })
  })

  it('rejects more than two decimals', () => {
    expect(parseDollarsToCents('0.005').ok).toBe(false)
  })
})

describe('margin percent edges', () => {
  it('parses percent strings to integer basis points', () => {
    expect(parsePercentToBps('40')).toEqual({ ok: true, bps: 4000 })
    expect(parsePercentToBps('40.5')).toEqual({ ok: true, bps: 4050 })
    expect(parsePercentToBps('0.01%')).toEqual({ ok: true, bps: 1 })
    expect(parsePercentToBps('99.99')).toEqual({ ok: true, bps: 9999 })
  })

  it('rejects 100 or more, negatives, and more than two decimals', () => {
    expect(parsePercentToBps('100').ok).toBe(false)
    expect(parsePercentToBps('-5').ok).toBe(false)
    expect(parsePercentToBps('40.125').ok).toBe(false)
    expect(parsePercentToBps('').ok).toBe(false)
  })

  it('formats basis points with two decimals', () => {
    expect(formatBps(4000)).toBe('40.00')
    expect(formatBps(5)).toBe('0.05')
    expect(formatBps(-1765)).toBe('-17.65')
  })
})
