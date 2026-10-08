import { describe, expect, it } from 'vitest'
import { formatAge, formatDateOfBirth } from './format'

describe('formatDateOfBirth', () => {
  it('reformats YYYY-MM-DD as MM/DD/YYYY without any timezone shift', () => {
    expect(formatDateOfBirth('1984-03-12')).toBe('03/12/1984')
    // New Year's Day would become 12/31 if parsed as UTC and shown in US time.
    expect(formatDateOfBirth('2000-01-01')).toBe('01/01/2000')
  })

  it('passes through anything that is not a plain date', () => {
    expect(formatDateOfBirth('unknown')).toBe('unknown')
  })
})

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    expect(formatAge(30)).toBe('under a minute')
    expect(formatAge(60)).toBe('1 minute')
    expect(formatAge(7200)).toBe('2 hours')
    expect(formatAge(172800)).toBe('2 days')
  })
})
