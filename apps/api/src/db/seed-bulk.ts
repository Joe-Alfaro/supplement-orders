// Deterministic demo patients so search and pagination have something to page through.
// A fixed LCG (not Math.random) makes every `db:seed` produce identical rows.

export interface BulkPatient {
  name: string
  /** YYYY-MM-DD */
  dateOfBirth: string
  address: string
}

const FIRST_NAMES = [
  'Avery',
  'Blake',
  'Casey',
  'Dana',
  'Elena',
  'Felix',
  'Grace',
  'Hector',
  'Imani',
  'Jonah',
  'Keiko',
  'Luis',
  'Mara',
  'Nikhil',
  'Olivia',
  'Priya',
  'Quinn',
  'Rosa',
  'Theo',
  'Uma',
  'Victor',
  'Wen',
  'Ximena',
  'Yusuf',
  'Zoe',
]

const LAST_NAMES = [
  'Abbott',
  'Baker',
  'Castillo',
  'Dubois',
  'Edwards',
  'Fischer',
  'Garcia',
  'Hughes',
  'Ibrahim',
  'Johansson',
  'Kowalski',
  'Lopez',
  'Murphy',
  'Nguyen',
  "O'Connor",
  'Park',
  'Quintero',
  'Rossi',
  'Schmidt',
  'Tanaka',
]

const STREETS = [
  'Maple Ave',
  'Oak St',
  'Cedar Ln',
  'Birch Rd',
  'Willow Way',
  'Spruce Ct',
  'Aspen Dr',
  'Sycamore Blvd',
  'Juniper Pl',
  'Magnolia St',
]

const CITIES = [
  'Seattle, WA 98101',
  'Austin, TX 78701',
  'Denver, CO 80202',
  'Chicago, IL 60601',
  'Atlanta, GA 30303',
  'Phoenix, AZ 85004',
  'Portland, ME 04101',
  'Madison, WI 53703',
]

/** Numerical Recipes LCG, modulus 2^32. */
function lcg(seed: number) {
  const state = { value: seed >>> 0 }
  return function next(modulus: number) {
    state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0
    return state.value % modulus
  }
}

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length]
  if (item === undefined) throw new Error('empty seed list')
  return item
}

const DAY_MS = 86_400_000
const EARLIEST_BIRTH_MS = Date.UTC(1936, 0, 1)
// 1936-01-01 through early 2007: ages about 18 to 90 in 2026.
const BIRTH_SPAN_DAYS = 26_000

function birthDate(dayOffset: number) {
  return new Date(EARLIEST_BIRTH_MS + dayOffset * DAY_MS)
    .toISOString()
    .slice(0, 10)
}

// Coprime with FIRST_NAMES x LAST_NAMES (500), so stepping by it visits every
// first/last pair exactly once, in a scattered but fixed order.
const NAME_STRIDE = 37

/**
 * Bulk patients alternate between providers by index (even -> first provider).
 * Every full name is unique across the whole seed: each patient gets a distinct
 * first/last pair, so the login list never shows two identical entries.
 */
export function generatePatients(total: number): BulkPatient[] {
  const pairCount = FIRST_NAMES.length * LAST_NAMES.length
  if (total > pairCount) {
    throw new Error(`only ${pairCount} unique patient names available`)
  }
  const next = lcg(19871231)
  const nextDay = lcg(19560704)
  return Array.from({ length: total }, (_, i) => {
    const pair = (i * NAME_STRIDE) % pairCount
    return {
      name: `${pick(FIRST_NAMES, pair)} ${pick(LAST_NAMES, Math.floor(pair / FIRST_NAMES.length))}`,
      dateOfBirth: birthDate(nextDay(BIRTH_SPAN_DAYS)),
      address: `${100 + next(9800)} ${pick(STREETS, next(STREETS.length))}, ${pick(CITIES, next(CITIES.length))}`,
    }
  })
}
