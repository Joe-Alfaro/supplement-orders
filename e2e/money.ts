/**
 * Dollar strings from the UI become integer cents. Strips "$" and commas, then
 * splits on ".". Never uses parseFloat or floating-point scaling.
 */
export function dollarsToCents(displayed: string): number {
  const stripped = displayed.trim().replace(/[$,]/g, '')
  const negative = stripped.startsWith('-')
  const unsigned = negative ? stripped.slice(1) : stripped
  const pieces = unsigned.split('.')
  const whole = pieces[0] ?? ''
  const fraction = pieces[1] ?? ''
  if (
    pieces.length > 2 ||
    !/^\d+$/.test(whole) ||
    !/^\d{0,2}$/.test(fraction)
  ) {
    throw new Error(`Cannot parse money "${displayed}"`)
  }
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Money is out of range "${displayed}"`)
  }
  return negative ? -cents : cents
}

/** First "$1,234.56" token in a larger accessible name or region. */
export function moneyIn(text: string): number {
  const amount = text.match(/-?\$\d[\d,]*(?:\.\d{1,2})?/)?.[0]
  if (!amount) throw new Error(`No dollar amount in "${text}"`)
  return dollarsToCents(amount)
}

/** "14.17" for an input, or the digits after "$" in a formatted amount. */
export function centsToInput(cents: number): string {
  const absolute = Math.abs(cents)
  const remainder = absolute % 100
  const dollars = (absolute - remainder) / 100
  const grouped = String(dollars).replace(/\B(?=(\d{3})+$)/g, ',')
  return `${grouped}.${String(remainder).padStart(2, '0')}`
}

/** "$1,234.56". Matches the on-screen money format, including a leading minus. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${centsToInput(cents)}`
}

/** 75 bps of an amount, rounded half up, in integer cents. */
export function platformFeeCents(amountCents: number): number {
  return Math.floor((amountCents * 75 + 5_000) / 10_000)
}

/** The line after an exact label in a block of text, such as a dialog or tile. */
export function textAfter(text: string, label: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const value = lines[lines.indexOf(label) + 1]
  if (lines.indexOf(label) < 0 || value === undefined) {
    throw new Error(`No line after "${label}" in:\n${text}`)
  }
  return value
}
