import { sql } from 'drizzle-orm'
import type { Db } from './client'
import { patients, products, providers, users } from './schema'
import { generatePatients, generateProducts } from './seed-bulk'

interface SeedProvider {
  name: string
  patients: { name: string; dateOfBirth: string; address: string }[]
}

// Two providers so ownership boundaries are demonstrable; the first has two patients.
const SEED_PROVIDERS: SeedProvider[] = [
  {
    name: 'Dr. Maya Rivera',
    patients: [
      {
        name: 'Jordan Lee',
        dateOfBirth: '1984-03-14',
        address: '214 Alder St, Portland, OR 97205',
      },
      {
        name: 'Sam Patel',
        dateOfBirth: '1971-11-02',
        address: '88 Elm Ave, Austin, TX 78704',
      },
    ],
  },
  {
    name: 'Dr. Owen Brooks',
    patients: [
      {
        name: 'Alex Kim',
        dateOfBirth: '1993-07-21',
        address: '1502 Pine Rd, Denver, CO 80203',
      },
      {
        name: 'Riley Chen',
        dateOfBirth: '1958-01-30',
        address: '9 Harbor Way, Boston, MA 02110',
      },
    ],
  },
]

const SEED_PRODUCTS = [
  {
    sku: 'VITD3-5000',
    name: 'Vitamin D3 5000 IU (120 softgels)',
    cogsCents: 850,
    stockQuantity: 120,
  },
  {
    sku: 'MAG-GLY-400',
    name: 'Magnesium Glycinate 400 mg (90 caps)',
    cogsCents: 1275,
    stockQuantity: 80,
  },
  {
    sku: 'OMEGA3-1000',
    name: 'Omega-3 Fish Oil 1000 mg (60 softgels)',
    cogsCents: 1640,
    stockQuantity: 60,
  },
  {
    sku: 'PROBIO-50B',
    name: 'Probiotic 50 Billion CFU (30 caps)',
    cogsCents: 2199,
    stockQuantity: 40,
  },
  {
    sku: 'B-COMPLEX',
    name: 'Methylated B-Complex (60 caps)',
    cogsCents: 990,
    stockQuantity: 25,
  },
]

export interface SeededProvider {
  userId: number
  providerId: number
  patients: { userId: number; patientId: number }[]
}

export interface SeedResult {
  providers: SeededProvider[]
  products: { id: number; cogsCents: number; stockQuantity: number }[]
}

/** Every table, in an order TRUNCATE ... CASCADE accepts. */
const ALL_TABLES = sql`ledger_entries, payments, order_items, orders, products, patients, providers, users`

/** Removes all data and restarts ids so a reseed produces the same ids every time. */
export async function truncateAll(db: Db) {
  await db.execute(sql`truncate table ${ALL_TABLES} restart identity cascade`)
}

async function seedProvider(db: Db, seed: SeedProvider) {
  const [user] = await db
    .insert(users)
    .values({ name: seed.name, role: 'provider' })
    .returning()
  const [provider] = await db
    .insert(providers)
    .values({ userId: user!.id })
    .returning()

  const seededPatients = await seed.patients.reduce<
    Promise<SeededProvider['patients']>
  >(async (accP, patient) => {
    const acc = await accP
    const [patientUser] = await db
      .insert(users)
      .values({ name: patient.name, role: 'patient' })
      .returning()
    const [row] = await db
      .insert(patients)
      .values({
        userId: patientUser!.id,
        providerId: provider!.id,
        dateOfBirth: patient.dateOfBirth,
        address: patient.address,
      })
      .returning()
    return [...acc, { userId: patientUser!.id, patientId: row!.id }]
  }, Promise.resolve([]))

  return {
    userId: user!.id,
    providerId: provider!.id,
    patients: seededPatients,
  }
}

/** Generated rows on top of the named ones, for a demo-sized catalog and patient list. */
const BULK_PRODUCT_COUNT = 295
const BULK_PATIENT_COUNT = 246

export interface SeedOptions {
  /** Add ~300 products and ~250 patients. Off for tests, on for `db:seed`. */
  bulk?: boolean
}

/** Bulk patients alternate between the seeded providers. */
async function seedBulkPatients(db: Db, providerIds: number[]) {
  const generated = generatePatients(BULK_PATIENT_COUNT)
  const inserted = await db
    .insert(users)
    .values(generated.map((p) => ({ name: p.name, role: 'patient' as const })))
    .returning({ id: users.id })
  // Serial ids are assigned in VALUES order, so sorting by id restores it.
  const userIds = inserted.map((u) => u.id).sort((a, b) => a - b)
  await db.insert(patients).values(
    generated.map((patient, i) => ({
      userId: userIds[i]!,
      providerId: providerIds[i % providerIds.length]!,
      dateOfBirth: patient.dateOfBirth,
      address: patient.address,
    })),
  )
}

/**
 * Inserts the seed data into empty tables. Named rows go first and in order, so
 * their ids are the same with or without the bulk rows.
 */
export async function seedDatabase(
  db: Db,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const seededProviders = await SEED_PROVIDERS.reduce<
    Promise<SeededProvider[]>
  >(
    async (accP, seed) => [...(await accP), await seedProvider(db, seed)],
    Promise.resolve([]),
  )

  const seededProducts = await db
    .insert(products)
    .values(SEED_PRODUCTS)
    .returning({
      id: products.id,
      cogsCents: products.cogsCents,
      stockQuantity: products.stockQuantity,
    })

  if (options.bulk) {
    await db.insert(products).values(generateProducts(BULK_PRODUCT_COUNT))
    await seedBulkPatients(
      db,
      seededProviders.map((p) => p.providerId),
    )
  }

  return { providers: seededProviders, products: seededProducts }
}
