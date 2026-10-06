export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString()
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString()
}

/**
 * A date of birth ('YYYY-MM-DD') as MM/DD/YYYY. DOB is a plain calendar date,
 * so it is reformatted as text; `new Date('YYYY-MM-DD')` would parse it as UTC
 * midnight and show the previous day west of Greenwich.
 */
export function formatDateOfBirth(isoDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate
  const [, year, month, day] = match
  return `${month}/${day}/${year}`
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole calendar days, in the viewer's timezone, from `iso` to `now`: sent
 * yesterday evening is 1 day even if fewer than 24 hours ago. Midnights are
 * compared as UTC dates so a DST shift can't add or drop a day.
 */
export function daysWaiting(iso: string, now = new Date()) {
  const sent = new Date(iso)
  const days =
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(sent.getFullYear(), sent.getMonth(), sent.getDate())) /
    MS_PER_DAY
  return Math.max(0, days)
}
