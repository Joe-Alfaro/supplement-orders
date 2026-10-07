import type { LocationQuery } from 'vue-router'
import type { DashboardRangeDto } from '@supplement-orders/domain'
import type { DashboardParams } from '../api'

// The dashboard range lives in the URL exactly as the API takes it
// (DOMAIN_CONTRACT 11a-v2). The server resolves "this month", "last 30 days"
// and the day boundaries; the UI does no date arithmetic.

/** The URL's range keys; the default This month is the empty object. */
export interface RangeParams {
  range?: string
  from?: string
  to?: string
}

export const DEFAULT_RANGE: RangeParams = {}

function text(query: LocationQuery, key: string) {
  const value = query[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** `?range=&from=&to=` passed through as written; the server judges validity. */
export function rangeFromQuery(query: LocationQuery): RangeParams {
  const range = text(query, 'range')
  const from = text(query, 'from')
  const to = text(query, 'to')
  return {
    ...(range && range !== 'month' ? { range } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }
}

/** The URL query for a range: the default writes nothing. */
export function rangeToQuery(params: RangeParams) {
  return { ...params }
}

export function sameRange(a: RangeParams, b: RangeParams) {
  return a.range === b.range && a.from === b.from && a.to === b.to
}

/** The browser's IANA zone, which the server uses for the day boundaries. */
export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function toDashboardParams(params: RangeParams): DashboardParams {
  return { ...params, tz: browserTimeZone() }
}

const MONTH_DAY = { month: 'short', day: 'numeric' } as const
const FULL = { ...MONTH_DAY, year: 'numeric' } as const

function dayParts(day: string) {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  return { year, month, date }
}

/** A `YYYY-MM-DD` day as a local Date, for the date picker only. */
export function dayToDate(day: string) {
  const { year, month, date } = dayParts(day)
  return new Date(year, month - 1, date)
}

/** The local calendar day of a picked Date, as the API's `YYYY-MM-DD`. */
export function dateToDay(value: Date) {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const date = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${date}`
}

/** Formats a calendar day as written, not shifted by the viewer's zone. */
function dayText(day: string, options: Intl.DateTimeFormatOptions) {
  const { year, month, date } = dayParts(day)
  const utc = new Date(Date.UTC(year, month - 1, date))
  return utc.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' })
}

/** "All time", "Oct 7, 2026", "Oct 1 – Oct 7, 2026" or across years in full. */
export function rangeLabel({ preset, from, to }: DashboardRangeDto) {
  if (preset === 'all' || !from || !to) return 'All time'
  if (from === to) return dayText(from, FULL)
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  return `${dayText(from, sameYear ? MONTH_DAY : FULL)} – ${dayText(to, FULL)}`
}
