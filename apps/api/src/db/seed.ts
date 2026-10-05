import { sql } from 'drizzle-orm'
import type { Db } from './client'
import { patients, products, providers, users } from './schema'

interface SeedProvider {
  name: string
  patients: { name: string; address: string }[]
}

// Two providers so ownership boundaries are demonstrable; the first has two patients.
const SEED_PROVIDERS: SeedProvider[] = [
  {
    name: 'Dr. Maya Rivera',
    patients: [
      { name: 'Jordan Lee', address: '214 Alder St, Portland, OR 97205' },
      { name: 'Sam Patel', address: '88 Elm Ave, Austin, TX 78704' },
    ],
  },
  {
    name: 'Dr. Owen Brooks',
    patients: [
      { name: 'Alex Kim', address: '1502 Pine Rd, Denver, CO 80203' },
      { name: 'Riley Chen', address: '9 Harbor Way, Boston, MA 02110' },
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

/** Inserts the seed data into empty tables. Sequential so ids are deterministic. */
export async function seedDatabase(db: Db): Promise<SeedResult> {
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

  return { providers: seededProviders, products: seededProducts }
}
