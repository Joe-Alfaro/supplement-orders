// Patient search treats the whole query as a date of birth when it is a real
// calendar date in one of the two formats clinicians type. Anything else,
// including impossible dates such as 02/30/1990, is ordinary name text.

const US_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (year < 1 || month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  const pad = (n: number, width: number) => String(n).padStart(width, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/**
 * Returns `YYYY-MM-DD` when the trimmed query is exactly a valid `MM/DD/YYYY`
 * or `YYYY-MM-DD` date, otherwise null. Month and day need two digits.
 */
export function parseDateOfBirthQuery(q: string): string | null {
  const trimmed = q.trim()
  const us = US_DATE.exec(trimmed)
  if (us) return toIsoDate(Number(us[3]), Number(us[1]), Number(us[2]))
  const iso = ISO_DATE.exec(trimmed)
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  return null
}
