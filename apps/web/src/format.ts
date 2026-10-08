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

/** A duration in seconds as its largest whole unit: "5 minutes", "2 hours", "1 day". */
export function formatAge(seconds: number) {
  const units = [
    { name: 'day', size: 86400 },
    { name: 'hour', size: 3600 },
    { name: 'minute', size: 60 },
  ]
  const unit = units.find((candidate) => seconds >= candidate.size)
  if (!unit) return 'under a minute'
  const count = Math.floor(seconds / unit.size)
  return `${count} ${unit.name}${count === 1 ? '' : 's'}`
}
