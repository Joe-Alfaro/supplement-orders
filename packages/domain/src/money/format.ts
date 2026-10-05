export type ParseResult =
  { ok: true; cents: number } | { ok: false; error: string }

// Optional "$", then either comma-grouped thousands or plain digits, then up to two decimals.
const DOLLAR_AMOUNT = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+$)/g, ',')
}

export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(
      `Expected a safe integer number of cents, got ${cents}`,
    )
  }
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  const remainder = absolute % 100
  const dollars = (absolute - remainder) / 100
  const centsPart = String(remainder).padStart(2, '0')
  return `${sign}$${groupThousands(String(dollars))}.${centsPart}`
}

export function parseDollarsToCents(input: string): ParseResult {
  const match = DOLLAR_AMOUNT.exec(input.trim())
  if (!match) {
    return { ok: false, error: 'Enter a dollar amount like 12.34' }
  }
  const [, dollarDigits = '', fraction = ''] = match
  // Concatenate the digit strings instead of multiplying a float by 100.
  const cents = Number(
    `${dollarDigits.replaceAll(',', '')}${fraction.padEnd(2, '0')}`,
  )
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, error: 'Amount is too large' }
  }
  return { ok: true, cents }
}
