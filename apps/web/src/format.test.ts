import { describe, expect, it } from 'vitest'
import { daysWaiting, formatDateOfBirth } from './format'

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

describe('daysWaiting', () => {
  // Local times, so the cases hold in any timezone.
  const now = new Date(2026, 9, 6, 9, 0)

  it('counts calendar days since the order was sent', () => {
    expect(daysWaiting(new Date(2026, 9, 6, 8, 0).toISOString(), now)).toBe(0)
    expect(daysWaiting(new Date(2026, 9, 5, 23, 59).toISOString(), now)).toBe(1)
    expect(daysWaiting(new Date(2026, 9, 1, 12, 0).toISOString(), now)).toBe(5)
    expect(daysWaiting(new Date(2026, 8, 6, 12, 0).toISOString(), now)).toBe(30)
  })

  it('never goes negative when the clock is behind the server', () => {
    expect(daysWaiting(new Date(2026, 9, 7, 1, 0).toISOString(), now)).toBe(0)
  })
})
