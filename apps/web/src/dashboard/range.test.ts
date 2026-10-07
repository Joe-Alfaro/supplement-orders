import { describe, expect, it } from 'vitest'
import {
  rangeFromQuery,
  rangeLabel,
  rangeToQuery,
  toDashboardParams,
} from './range'

describe('rangeFromQuery', () => {
  it('is the default (empty) with no params', () => {
    expect(rangeFromQuery({})).toEqual({})
  })

  it('drops an explicit month, which is the default', () => {
    expect(rangeFromQuery({ range: 'month' })).toEqual({})
  })

  it('passes presets through', () => {
    expect(rangeFromQuery({ range: 'last30' })).toEqual({ range: 'last30' })
    expect(rangeFromQuery({ range: 'all' })).toEqual({ range: 'all' })
  })

  it('passes custom days through without judging them', () => {
    expect(
      rangeFromQuery({ range: 'custom', from: '2026-10-07', to: '2026-02-30' }),
    ).toEqual({ range: 'custom', from: '2026-10-07', to: '2026-02-30' })
  })

  it('ignores empty and repeated values', () => {
    expect(rangeFromQuery({ range: '', from: ['a', 'b'] })).toEqual({})
  })
})

describe('rangeToQuery', () => {
  it('writes only what the range holds', () => {
    expect(rangeToQuery({})).toEqual({})
    expect(rangeToQuery({ range: 'all' })).toEqual({ range: 'all' })
  })
})

describe('toDashboardParams', () => {
  it("adds the browser's time zone", () => {
    expect(toDashboardParams({ range: 'last30' })).toEqual({
      range: 'last30',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })
})

describe('rangeLabel', () => {
  const zone = { timeZone: 'America/Chicago' }

  it('names All time', () => {
    expect(rangeLabel({ preset: 'all', from: null, to: null, ...zone })).toBe(
      'All time',
    )
  })

  it('writes the year once inside one year', () => {
    expect(
      rangeLabel({
        preset: 'month',
        from: '2026-10-01',
        to: '2026-10-07',
        ...zone,
      }),
    ).toBe('Oct 1 – Oct 7, 2026')
  })

  it('writes both years across a year boundary', () => {
    expect(
      rangeLabel({
        preset: 'custom',
        from: '2025-12-28',
        to: '2026-01-03',
        ...zone,
      }),
    ).toBe('Dec 28, 2025 – Jan 3, 2026')
  })

  it('writes one day once', () => {
    expect(
      rangeLabel({
        preset: 'custom',
        from: '2026-10-07',
        to: '2026-10-07',
        ...zone,
      }),
    ).toBe('Oct 7, 2026')
  })
})
