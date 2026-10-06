import { sql } from 'drizzle-orm'
import type { Db } from './client'
import { patients, products, providers, users } from './schema'
import { generatePatients, generateProducts } from './seed-bulk'

/*
 * Named seed: what the API test harness and `npm run e2e:db` load (no bulk rows).
 * Tables are truncated with RESTART IDENTITY first, so these ids are stable.
 * Tests and e2e specs may rely on every value below; change them together.
 *
 * Users (sign-in list order = id order)
 *   id 1  Dr. Maya Rivera  provider 1  patients: Jordan Lee, Sam Patel
 *   id 2  Jordan Lee       patient 1   DOB 1984-03-14 (03/14/1984)  214 Alder St, Portland, OR 97205
 *   id 3  Sam Patel        patient 2   DOB 1971-11-02 (11/02/1971)  88 Elm Ave, Austin, TX 78704
 *   id 4  Dr. Owen Brooks  provider 2  patients: Alex Kim, Riley Chen
 *   id 5  Alex Kim         patient 3   DOB 1993-07-21 (07/21/1993)  1502 Pine Rd, Denver, CO 80203
 *   id 6  Riley Chen       patient 4   DOB 1958-01-30 (01/30/1958)  9 Harbor Way, Boston, MA 02110
 *
 * Products (id, SKU, name, wholesale cost, stock, minimum unit price)
 *   1  VITD3-5000   Vitamin D3 5000 IU (120 softgels)        $8.50   120  $8.57
 *   2  MAG-GLY-400  Magnesium Glycinate 400 mg (90 caps)     $12.75   80  $12.85
 *   3  OMEGA3-1000  Omega-3 Fish Oil 1000 mg (60 softgels)   $16.40   60  $16.53
 *   4  PROBIO-50B   Probiotic 50 Billion CFU (30 caps)       $21.99   40  $22.16
 *   5  B-COMPLEX    Methylated B-Complex (60 caps)           $9.90    25  $9.98
 * Listed by name (the API's order): Magnesium, Methylated B-Complex, Omega-3,
 * Probiotic, Vitamin D3. No orders, payments or ledger rows are seeded.
 */

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
