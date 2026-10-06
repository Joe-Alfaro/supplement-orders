// `npm run explain:search -w apps/api`: evidence that the pg_trgm indexes from
// migration 0005 serve the product and patient search queries at scale. Not a
// test. It loads a deterministic synthetic catalog into a throwaway database,
// prints EXPLAIN (ANALYZE, BUFFERS) without the trigram indexes, then applies
// 0005's statements and prints the same plans again. The database is dropped
// at the end.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { and, asc, count, eq, type SQL } from 'drizzle-orm'
import pg from 'pg'
import { createDb, type Db } from '../src/db/client'
import {
  ensureDatabase,
  siblingDatabaseUrl,
  testDatabaseName,
} from '../src/db/databases'
import { runMigrations } from '../src/db/migrate'
import { patients, products, providers, users } from '../src/db/schema'
import { matchesSearch } from '../src/http/search'

const PRODUCT_COUNT = 50_000
const PATIENT_COUNT = 20_000
const PROVIDER_COUNT = 2
const BATCH = 5_000
const PAGE = { limit: 25, offset: 0 }
const TRGM_INDEXES = [
  'products_name_trgm_idx',
  'products_sku_trgm_idx',
  'users_name_trgm_idx',
]
const MIGRATION_0005 = fileURLToPath(
  new URL('../drizzle/0005_rev6_trgm_search.sql', import.meta.url),
)
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const SYLLABLES = [
  'ba',
  'ce',
  'di',
  'fo',
  'ga',
  'he',
  'ki',
  'lo',
  'ma',
  'ne',
  'ri',
  'so',
  'ta',
  've',
  'xu',
  'zo',
  'lu',
  'pe',
  'qui',
  'wen',
  'dra',
  'mor',
  'sel',
  'tan',
]
const NUTRIENTS = [
  ['Vitamin C', 'VITC'],
  ['Vitamin D3', 'VITD3'],
  ['Magnesium Glycinate', 'MAG'],
  ['Zinc Picolinate', 'ZINC'],
  ['Omega-3 Fish Oil', 'OMG3'],
  ['CoQ10', 'COQ10'],
  ['Curcumin', 'CURC'],
  ['Ashwagandha', 'ASHW'],
  ['Berberine', 'BERB'],
  ['Probiotic 50B', 'PRO50'],
] as const
const FORMS = [
  ['Capsules', 'CAP'],
  ['Tablets', 'TAB'],
  ['Softgels', 'SG'],
  ['Gummies', 'GUM'],
  ['Powder', 'PWD'],
] as const
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
]

/**
 * Numerical Recipes LCG, modulus 2^32. Unlike seed-bulk.ts it scales the high
 * bits into range: the low bits of this LCG cycle with a short period, which
 * would repeat made-up words far more often than real names repeat.
 */
function lcg(seed: number) {
  const state = { value: seed >>> 0 }
  return function next(modulus: number) {
    state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0
    return Math.floor((state.value / 2 ** 32) * modulus)
  }
}

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length]
  if (item === undefined) throw new Error('empty list')
  return item
}

/** A capitalized made-up word of `syllables` syllables (24^n combinations). */
function word(next: (modulus: number) => number, syllables: number) {
  const raw = Array.from({ length: syllables }, () =>
    pick(SYLLABLES, next(SYLLABLES.length)),
  ).join('')
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

function chunks<T>(items: T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) =>
    items.slice(i * BATCH, (i + 1) * BATCH),
  )
}

/** Runs one async step per item, in order. */
async function inSequence<T>(items: T[], step: (item: T) => Promise<void>) {
  await items.reduce(
    (done, item) => done.then(() => step(item)),
    Promise.resolve(),
  )
}

function generateProducts() {
  const next = lcg(20261006)
  return Array.from({ length: PRODUCT_COUNT }, (_, i) => {
    const [nutrient, nutrientCode] = pick(NUTRIENTS, next(NUTRIENTS.length))
    const [form, formCode] = pick(FORMS, next(FORMS.length))
    const brand = word(next, 3)
    return {
      sku: `${nutrientCode}-${formCode}-${String(i + 1).padStart(6, '0')}`,
      name: `${brand} ${nutrient} ${form}`,
      cogsCents: 200 + next(4000),
      stockQuantity: next(200),
    }
  })
}

function generatePatientNames() {
  const next = lcg(19871231)
  return Array.from(
    { length: PATIENT_COUNT },
    () => `${pick(FIRST_NAMES, next(FIRST_NAMES.length))} ${word(next, 3)}`,
  )
}

async function load(db: Db) {
  await inSequence(chunks(generateProducts()), async (rows) => {
    await db.insert(products).values(rows)
  })

  const providerUsers = await db
    .insert(users)
    .values(
      Array.from({ length: PROVIDER_COUNT }, (_, i) => ({
        name: `Dr. Provider ${i + 1}`,
        role: 'provider' as const,
      })),
    )
    .returning({ id: users.id })
  const providerRows = await db
    .insert(providers)
    .values(providerUsers.map((u) => ({ userId: u.id })))
    .returning({ id: providers.id })
  const providerIds = providerRows.map((p) => p.id)

  const names = generatePatientNames()
  await inSequence(
    chunks(names.map((name, i) => ({ name, i }))),
    async (rows) => {
      const created = await db
        .insert(users)
        .values(rows.map((r) => ({ name: r.name, role: 'patient' as const })))
        .returning({ id: users.id })
      await db.insert(patients).values(
        created.map((u, j) => {
          const i = (rows[j]?.i ?? 0) + 1
          return {
            userId: u.id,
            providerId: pick(providerIds, i),
            dateOfBirth: `19${String(40 + (i % 60))}-0${1 + (i % 9)}-1${i % 10}`,
            address: `${i} Main St`,
          }
        }),
      )
    },
  )
  return { providerIds, names }
}

/** The product list query from http/products.ts: one page and the total. */
function productQueries(db: Db, q: string) {
  const where = matchesSearch(q, [products.name, products.sku])
  return {
    page: db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        cogsCents: products.cogsCents,
        stockQuantity: products.stockQuantity,
      })
      .from(products)
      .where(where)
      .orderBy(asc(products.name), asc(products.id))
      .limit(PAGE.limit)
      .offset(PAGE.offset)
      .toSQL(),
    count: db.select({ total: count() }).from(products).where(where).toSQL(),
  }
}

/**
 * The patient list query from http/patients.ts for a name (non-date) query,
 * scoped to one provider: one page and the total.
 */
function patientQueries(db: Db, providerId: number, q: string) {
  const where: SQL | undefined = and(
    eq(patients.providerId, providerId),
    matchesSearch(q, [users.name]),
  )
  return {
    page: db
      .select({
        id: patients.id,
        userId: patients.userId,
        providerId: patients.providerId,
        name: users.name,
        dateOfBirth: patients.dateOfBirth,
        address: patients.address,
      })
      .from(patients)
      .innerJoin(users, eq(users.id, patients.userId))
      .where(where)
      .orderBy(asc(users.name), asc(patients.id))
      .limit(PAGE.limit)
      .offset(PAGE.offset)
      .toSQL(),
    count: db
      .select({ total: count() })
      .from(patients)
      .innerJoin(users, eq(users.id, patients.userId))
      .where(where)
      .toSQL(),
  }
}

interface Probe {
  label: string
  query: { sql: string; params: unknown[] }
}

/** Timed EXPLAIN ANALYZE runs per probe; the median is reported. */
const RUNS = 5

function executionMs(plan: string[]) {
  const line = plan.find((l) => l.startsWith('Execution Time')) ?? ''
  return Number(/([\d.]+) ms/.exec(line)?.[1] ?? Number.NaN)
}

/** One warm-up, then RUNS timed runs; the median time and the last plan. */
async function explain(pool: pg.Pool, probe: Probe) {
  const text = `EXPLAIN (ANALYZE, BUFFERS) ${probe.query.sql}`
  await pool.query(text, probe.query.params)
  const plans = await Array.from({ length: RUNS }).reduce<Promise<string[][]>>(
    async (acc) => {
      const result = await pool.query<{ 'QUERY PLAN': string }>(
        text,
        probe.query.params,
      )
      return [...(await acc), result.rows.map((r) => r['QUERY PLAN'])]
    },
    Promise.resolve([]),
  )
  const times = plans.map(executionMs).sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)] ?? Number.NaN
  return { plan: plans.at(-1) ?? [], time: `${median.toFixed(3)} ms` }
}

async function report(pool: pg.Pool, phase: string, probes: Probe[]) {
  const results = await probes.reduce(
    async (acc, probe) => [
      ...(await acc),
      { probe, ...(await explain(pool, probe)) },
    ],
    Promise.resolve([] as { probe: Probe; plan: string[]; time: string }[]),
  )
  console.log(`\n==================== ${phase} ====================`)
  results.forEach(({ probe, plan }) => {
    console.log(`\n--- ${phase}: ${probe.label}\n${probe.query.sql}`)
    console.log(`params: ${JSON.stringify(probe.query.params)}\n`)
    console.log(plan.join('\n'))
  })
  return results.map((r) => ({ label: r.probe.label, time: r.time }))
}

async function dropDatabase(url: string) {
  const name = new URL(url).pathname.slice(1)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    await client.query(
      `drop database if exists "${name.replaceAll('"', '""')}" with (force)`,
    )
  } finally {
    await client.end()
  }
}

async function main() {
  const name = testDatabaseName(process.env, REPO_ROOT)
    .replace(/^supplement_orders_test/, 'supplement_orders_explain')
    .slice(0, 63)
  if (!name.startsWith('supplement_orders_explain')) {
    throw new Error(`refusing to use ${name} as the throwaway database`)
  }
  const url = siblingDatabaseUrl(name)
  await dropDatabase(url)
  await ensureDatabase(url)
  const { db, pool } = createDb(url)

  try {
    await runMigrations(db)
    await pool.query(
      TRGM_INDEXES.map((index) => `drop index ${index};`).join(' '),
    )
    console.log(`Loading into ${name}...`)
    const { providerIds, names } = await load(db)
    await pool.query('analyze')

    // Deterministic probes: a brand fragment, a SKU fragment, a common
    // ingredient, and one generated patient's surname, searched as their
    // provider (load() assigns patient index i to provider i + 1).
    const patientIndex = 4242
    const surname = names[patientIndex]?.split(' ')[1] ?? ''
    const providerId = pick(providerIds, patientIndex + 1)
    const [brand] = await db
      .select({ name: products.name })
      .from(products)
      .where(eq(products.id, 12_345))
    const brandFragment = brand?.name.slice(0, 6) ?? ''
    const skuFragment = '012345'
    const probeSet: Probe[] = [
      {
        label: `products q="${brandFragment}" brand fragment (page)`,
        query: productQueries(db, brandFragment).page,
      },
      {
        label: `products q="${brandFragment}" (count)`,
        query: productQueries(db, brandFragment).count,
      },
      {
        label: `products q="${skuFragment}" SKU fragment (page)`,
        query: productQueries(db, skuFragment).page,
      },
      {
        label: 'products q="ashwagandha" common ingredient (page)',
        query: productQueries(db, 'ashwagandha').page,
      },
      {
        label: 'products q="ashwagandha" (count)',
        query: productQueries(db, 'ashwagandha').count,
      },
      {
        label: `patients q="${surname}" provider ${providerId} (page)`,
        query: patientQueries(db, providerId, surname).page,
      },
      {
        label: `patients q="${surname}" provider ${providerId} (count)`,
        query: patientQueries(db, providerId, surname).count,
      },
    ]

    const before = await report(pool, 'BEFORE (no trigram indexes)', probeSet)

    const statements = readFileSync(MIGRATION_0005, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    await inSequence(statements, async (statement) => {
      await pool.query(statement)
    })
    await pool.query('analyze')

    const after = await report(pool, 'AFTER (migration 0005)', probeSet)

    console.log('\n==================== SUMMARY ====================')
    console.log(
      `${PRODUCT_COUNT} products, ${PATIENT_COUNT} patients over ${PROVIDER_COUNT} providers`,
    )
    before.forEach((b, i) => {
      console.log(
        `${b.label}\n  before: ${b.time}\n  after:  ${after[i]?.time}`,
      )
    })
  } finally {
    await pool.end()
    await dropDatabase(url)
  }
}

await main()
