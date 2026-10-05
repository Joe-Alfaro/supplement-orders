// Deterministic demo data so search and pagination have something to page through.
// A fixed LCG (not Math.random) makes every `db:seed` produce identical rows.

export interface BulkProduct {
  sku: string
  name: string
  cogsCents: number
  stockQuantity: number
}

export interface BulkPatient {
  name: string
  /** YYYY-MM-DD */
  dateOfBirth: string
  address: string
}

const NUTRIENTS = [
  { name: 'Vitamin C', code: 'VITC', baseCents: 650 },
  { name: 'Vitamin B12', code: 'B12', baseCents: 720 },
  { name: 'Vitamin K2', code: 'VITK2', baseCents: 1180 },
  { name: 'Vitamin E', code: 'VITE', baseCents: 890 },
  { name: 'Zinc Picolinate', code: 'ZINC', baseCents: 540 },
  { name: 'Iron Bisglycinate', code: 'IRON', baseCents: 610 },
  { name: 'Selenium', code: 'SEL', baseCents: 480 },
  { name: 'Calcium Citrate', code: 'CALC', baseCents: 760 },
  { name: 'Folate', code: 'FOL', baseCents: 830 },
  { name: 'CoQ10', code: 'COQ10', baseCents: 2150 },
  { name: 'Curcumin', code: 'CURC', baseCents: 1720 },
  { name: 'Ashwagandha', code: 'ASHW', baseCents: 1390 },
  { name: 'Berberine', code: 'BERB', baseCents: 1960 },
  { name: 'NAC', code: 'NAC', baseCents: 1240 },
  { name: 'Quercetin', code: 'QUER', baseCents: 1450 },
  { name: 'L-Theanine', code: 'LTHE', baseCents: 1060 },
  { name: 'Melatonin', code: 'MELA', baseCents: 420 },
  { name: 'Collagen Peptides', code: 'COLL', baseCents: 2480 },
  { name: 'Alpha Lipoic Acid', code: 'ALA', baseCents: 1330 },
  { name: 'Glucosamine', code: 'GLUC', baseCents: 1150 },
]

const FORMS = [
  { name: 'Capsules', code: 'CAP', factor: 100 },
  { name: 'Tablets', code: 'TAB', factor: 90 },
  { name: 'Softgels', code: 'SG', factor: 115 },
  { name: 'Gummies', code: 'GUM', factor: 125 },
  { name: 'Powder', code: 'PWD', factor: 140 },
]

const COUNTS = [30, 60, 90, 120]

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

/** Every nutrient x form x count combination, cycled until `total` products. */
export function generateProducts(total: number): BulkProduct[] {
  const next = lcg(20261005)
  return Array.from({ length: total }, (_, i) => {
    const nutrient = pick(NUTRIENTS, i)
    const form = pick(FORMS, Math.floor(i / NUTRIENTS.length))
    const unitCount = pick(
      COUNTS,
      Math.floor(i / (NUTRIENTS.length * FORMS.length)),
    )
    const sizeFactor = unitCount / 60
    const jitter = 90 + next(21)
    const cogsCents = Math.round(
      (nutrient.baseCents * form.factor * sizeFactor * jitter) / 10_000,
    )
    return {
      sku: `${nutrient.code}-${form.code}-${unitCount}-${String(i + 1).padStart(3, '0')}`,
      name: `${nutrient.name} ${form.name} (${unitCount} ct)`,
      cogsCents,
      // About one in twelve is out of stock so the UI's disabled state is visible.
      stockQuantity: next(12) === 0 ? 0 : 5 + next(200),
    }
  })
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

/**
 * Bulk patients alternate between providers by index (even -> first provider).
 * Index 2 repeats index 0's name and index 3 repeats index 1's, each with a
 * different date of birth and the same provider, so the demo shows why the
 * list carries DOB.
 */
export function generatePatients(total: number): BulkPatient[] {
  const next = lcg(19871231)
  const nextDay = lcg(19560704)
  const names = Array.from(
    { length: total },
    (_, i) =>
      `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, Math.floor(i / FIRST_NAMES.length) + i)}`,
  )
  return names.map((name, i) => ({
    name: i === 2 || i === 3 ? (names[i - 2] ?? name) : name,
    dateOfBirth: birthDate(nextDay(BIRTH_SPAN_DAYS)),
    address: `${100 + next(9800)} ${pick(STREETS, next(STREETS.length))}, ${pick(CITIES, next(CITIES.length))}`,
  }))
}
