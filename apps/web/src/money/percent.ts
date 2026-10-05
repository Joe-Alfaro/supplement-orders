// Margin % input edge. Like dollar parsing, a percent with up to two decimals maps
// to an integer by string concatenation, never float multiplication: "40.5" -> 4050 bps.

export type PercentParseResult =
  { ok: true; bps: number } | { ok: false; error: string }

const PERCENT = /^(\d{1,2})(?:\.(\d{1,2}))?$/

/** Accepts 0 to 99.99 with up to two decimals and an optional trailing "%". */
export function parsePercentToBps(input: string): PercentParseResult {
  const match = PERCENT.exec(input.trim().replace(/%$/, '').trim())
  if (!match) {
    return { ok: false, error: 'Enter a margin from 0 to 99.99' }
  }
  const [, whole = '', fraction = ''] = match
  return { ok: true, bps: Number(`${whole}${fraction.padEnd(2, '0')}`) }
}

/** 4050 -> "40.50", -1765 -> "-17.65". */
export function formatBps(bps: number) {
  const sign = bps < 0 ? '-' : ''
  const absolute = Math.abs(bps)
  const remainder = absolute % 100
  const whole = (absolute - remainder) / 100
  return `${sign}${whole}.${String(remainder).padStart(2, '0')}`
}
