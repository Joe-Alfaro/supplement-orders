import { describe, expect, it } from 'vitest'
import { formatCents, parseDollarsToCents } from './index'

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
