// Markup % input edge. Like dollar parsing, a percent with up to two decimals maps
// to an integer by string concatenation, never float multiplication: "40.5" -> 4050 bps.

export type PercentParseResult =
  { ok: true; bps: number } | { ok: false; error: string }

const PERCENT = /^(\d+)(?:\.(\d{1,2}))?$/

/**
 * Accepts any non-negative percent with up to two decimals and an optional
 * trailing "%". Markup has no upper bound: "300" is 30000 bps.
 */
export function parsePercentToBps(input: string): PercentParseResult {
  const match = PERCENT.exec(input.trim().replace(/%$/, '').trim())
  if (!match) {
    return {
      ok: false,
      error: 'Enter a markup of 0 or more, with up to two decimals',
    }
  }
  const [, whole = '', fraction = ''] = match
  const bps = Number(`${whole}${fraction.padEnd(2, '0')}`)
  if (!Number.isSafeInteger(bps)) {
    return { ok: false, error: 'Markup is too large' }
  }
  return { ok: true, bps }
}

/** 4050 -> "40.50", -1765 -> "-17.65", 30000 -> "300.00". */
export function formatBps(bps: number) {
  const sign = bps < 0 ? '-' : ''
  const absolute = Math.abs(bps)
  const remainder = absolute % 100
  const whole = (absolute - remainder) / 100
  return `${sign}${whole}.${String(remainder).padStart(2, '0')}`
}
