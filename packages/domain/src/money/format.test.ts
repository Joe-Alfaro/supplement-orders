import { describe, expect, it } from 'vitest'
import { formatCents, parseDollarsToCents } from './format'

interface FormatCase {
  cents: number
  formatted: string
}

interface ParseAcceptCase {
  input: string
  cents: number
}

// Contract examples are the first four rows. The rest follow from those rules:
// always two decimals, '-' before '$', and commas every three integer digits.
const FORMAT_CASES: FormatCase[] = [
  { cents: 12090, formatted: '$120.90' },
  { cents: 0, formatted: '$0.00' },
  { cents: 123456789, formatted: '$1,234,567.89' },
  { cents: -500, formatted: '-$5.00' },
  { cents: 1, formatted: '$0.01' },
  { cents: 10, formatted: '$0.10' },
  { cents: 100, formatted: '$1.00' },
  { cents: 1000, formatted: '$10.00' },
  { cents: 100000, formatted: '$1,000.00' },
  { cents: 1000000, formatted: '$10,000.00' },
  { cents: 123456789012, formatted: '$1,234,567,890.12' },
  { cents: -1, formatted: '-$0.01' },
  { cents: -100, formatted: '-$1.00' },
  { cents: -12090, formatted: '-$120.90' },
  { cents: -123456789, formatted: '-$1,234,567.89' },
]

// The contract does not name the class. A non-integer must throw an Error.
const FORMAT_REJECTED: number[] = [
  0.1,
  1.5,
  -1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]

// Whole dollars, one decimal, and two decimals are all within the two-decimal limit.
// 2.30, 1.15, 0.29, 19.99, and 8.70 are not exact in binary. Splitting on '.'
// yields the cents below, while Math.floor(Number(input) * 100) does not.
const PARSE_ACCEPTED: ParseAcceptCase[] = [
  { input: '120.9', cents: 12090 },
  { input: '$1,234.5', cents: 123450 },
  { input: '0', cents: 0 },
  { input: '0.05', cents: 5 },
  { input: ' 12 ', cents: 1200 },
  { input: '12', cents: 1200 },
  { input: '120', cents: 12000 },
  { input: '1000', cents: 100000 },
  { input: '120.90', cents: 12090 },
  { input: '$120.90', cents: 12090 },
  { input: '0.5', cents: 50 },
  { input: '0.50', cents: 50 },
  { input: '0.00', cents: 0 },
  { input: '1,234', cents: 123400 },
  { input: '1,234,567.89', cents: 123456789 },
  { input: '$1,234,567.89', cents: 123456789 },
  { input: '2.30', cents: 230 },
  { input: '1.15', cents: 115 },
  { input: '0.29', cents: 29 },
  { input: '19.99', cents: 1999 },
  { input: '8.70', cents: 870 },
  { input: '  $1,234.50  ', cents: 123450 },
  { input: '$0.05', cents: 5 },
  { input: '12.3', cents: 1230 },
]

// The message text is not specified. Rejection is ok: false plus a non-empty string.
// Rows after the contract's list are the same rules applied strictly: trim of
// blank input, no leading dot, commas only as thousands groups, no sign, one
// dot, at most two decimal digits, and '$' only as a leading prefix.
const PARSE_REJECTED: string[] = [
  '',
  'abc',
  '1.234',
  '0.005',
  '-1',
  '1e3',
  '1,23',
  '$',
  '.',
  '12.',
  '1..2',
  '   ',
  '.5',
  '.50',
  '1,2345',
  '12,34',
  '-0.01',
  '-$1',
  '-$5.00',
  '1.2.3',
  '12.900',
  '$1,23',
  '12$',
  '1 234',
  '1,234.567',
  '$.50',
  '1E3',
]

function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (caught: unknown) {
    return caught
  }
  return undefined
}

function expectRejected(input: string): void {
  const result = parseDollarsToCents(input)
  expect(result.ok).toBe(false)
  if (result.ok) {
    return
  }
  expect(typeof result.error).toBe('string')
  expect(result.error.length).toBeGreaterThan(0)
}

describe('formatCents', () => {
  it.each(FORMAT_CASES)(
    'formats $cents as $formatted',
    ({ cents, formatted }) => {
      expect(formatCents(cents)).toBe(formatted)
    },
  )

  it.each(FORMAT_REJECTED)('throws on non-integer %s', (cents) => {
    expect(
      thrownBy(() => {
        formatCents(cents)
      }),
    ).toBeInstanceOf(Error)
  })

  it('round-trips non-negative formatted strings and rejects the negative format', () => {
    FORMAT_CASES.filter((item) => item.cents >= 0).forEach((item) => {
      const parsed = parseDollarsToCents(formatCents(item.cents))
      expect(parsed).toEqual({ ok: true, cents: item.cents })
    })
    expectRejected(formatCents(-500))
  })
})

describe('parseDollarsToCents', () => {
  it.each(PARSE_ACCEPTED)(
    'parses $input as $cents cents',
    ({ input, cents }) => {
      expect(parseDollarsToCents(input)).toEqual({ ok: true, cents })
    },
  )

  it.each(PARSE_REJECTED)('rejects %j', (input) => {
    expectRejected(input)
  })
})
