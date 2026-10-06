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

describe('markup percent edges', () => {
  it('parses percent strings to integer basis points', () => {
    expect(parsePercentToBps('40')).toEqual({ ok: true, bps: 4000 })
    expect(parsePercentToBps('40.5')).toEqual({ ok: true, bps: 4050 })
    expect(parsePercentToBps('0.01%')).toEqual({ ok: true, bps: 1 })
    expect(parsePercentToBps('0')).toEqual({ ok: true, bps: 0 })
  })

  it('has no upper bound: markup can exceed 100%', () => {
    expect(parsePercentToBps('99.99')).toEqual({ ok: true, bps: 9999 })
    expect(parsePercentToBps('300')).toEqual({ ok: true, bps: 30000 })
    expect(parsePercentToBps('1250.5')).toEqual({ ok: true, bps: 125050 })
  })

  it('rejects negatives, more than two decimals, and non-numbers', () => {
    expect(parsePercentToBps('-5').ok).toBe(false)
    expect(parsePercentToBps('abc').ok).toBe(false)
    expect(parsePercentToBps('40.125').ok).toBe(false)
    expect(parsePercentToBps('').ok).toBe(false)
  })

  it('formats basis points with two decimals', () => {
    expect(formatBps(4000)).toBe('40.00')
    expect(formatBps(5)).toBe('0.05')
    expect(formatBps(-1765)).toBe('-17.65')
    expect(formatBps(30000)).toBe('300.00')
  })
})
