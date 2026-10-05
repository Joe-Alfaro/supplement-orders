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
