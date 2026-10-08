import { SYSTEM_ACCOUNTS } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import type { Db } from './client'
import { accounts, patients, products, providers, users } from './schema'
import { generatePatients } from './seed-bulk'

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
 *   id 7  Ada Admin        admin (revision 13; no provider or patient profile)
 *
 * Products (id, SKU, name, wholesale cost, stock, minimum unit price)
 *   1  VITD3-5000   Vitamin D3 5000 IU (120 softgels)        $8.50   120  $8.57
 *   2  MAG-GLY-400  Magnesium Glycinate 400 mg (90 caps)     $12.75   80  $12.85
 *   3  OMEGA3-1000  Omega-3 Fish Oil 1000 mg (60 softgels)   $16.40   60  $16.53
 *   4  PROBIO-50B   Probiotic 50 Billion CFU (30 caps)       $21.99   40  $22.16
 *   5  B-COMPLEX    Methylated B-Complex (60 caps)           $9.90    25  $9.98
 * Listed by name (the API's order): Magnesium, Methylated B-Complex, Omega-3,
 * Probiotic, Vitamin D3. No orders, payments or journals are seeded.
 *
 * Accounts (revision 16): 1 = 1000 Cash, 2 = 4000 Product sales at wholesale
 * cost, 3 = 4100 Platform fee revenue (restored by truncateAll), then each
 * provider's payable, created by a database trigger with the provider:
 * 4 = 2100-1 Payable to Dr. Maya Rivera, 5 = 2100-2 Payable to Dr. Owen Brooks.
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

const SEED_ADMIN_NAME = 'Ada Admin'

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

/**
 * Revision 16.6: the demo seed (`db:seed`, `db:seed:if-empty`) has 12 products
 * with small stock, so stock changes can be checked by hand: one at 0, three at
 * 1-3 and the rest at 5-25. The first five are the named products above with
 * the same ids, SKUs and costs; only their stock differs.
 */
const DEMO_STOCK_BY_SKU: Record<string, number> = {
  'VITD3-5000': 12,
  'MAG-GLY-400': 8,
  'OMEGA3-1000': 2,
  'PROBIO-50B': 0,
  'B-COMPLEX': 15,
}

const DEMO_EXTRA_PRODUCTS = [
  {
    sku: 'ZINC-PIC-30',
    name: 'Zinc Picolinate 30 mg (60 caps)',
    cogsCents: 540,
    stockQuantity: 25,
  },
  {
    sku: 'COQ10-200',
    name: 'CoQ10 200 mg (60 softgels)',
    cogsCents: 2850,
    stockQuantity: 1,
  },
  {
    sku: 'CURC-500',
    name: 'Curcumin Phytosome 500 mg (60 caps)',
    cogsCents: 1960,
    stockQuantity: 6,
  },
  {
    sku: 'ASHW-600',
    name: 'Ashwagandha 600 mg (60 caps)',
    cogsCents: 1390,
    stockQuantity: 20,
  },
  {
    sku: 'NAC-600',
    name: 'N-Acetyl Cysteine 600 mg (90 caps)',
    cogsCents: 1240,
    stockQuantity: 3,
  },
  {
    sku: 'MELA-3',
    name: 'Melatonin 3 mg (120 tablets)',
    cogsCents: 420,
    stockQuantity: 18,
  },
  {
    sku: 'COLL-PEP',
    name: 'Collagen Peptides (30 servings)',
    cogsCents: 2480,
    stockQuantity: 10,
  },
]

export const DEMO_PRODUCTS = [
  ...SEED_PRODUCTS.map((product) => ({
    ...product,
    stockQuantity: DEMO_STOCK_BY_SKU[product.sku] ?? product.stockQuantity,
  })),
  ...DEMO_EXTRA_PRODUCTS,
]

export interface SeededProvider {
  userId: number
  providerId: number
  patients: { userId: number; patientId: number }[]
}

export interface SeedResult {
  providers: SeededProvider[]
  adminUserId: number
  products: { id: number; cogsCents: number; stockQuantity: number }[]
}

/** Every table, in an order TRUNCATE ... CASCADE accepts. */
const ALL_TABLES = sql`inventory_adjustments, postings, journals, accounts, payments, payment_attempts, fake_gateway_charges, order_items, orders, products, patients, providers, users`

/** The database or a transaction on it; seeding only inserts (and reads). */
type Inserter = Pick<Db, 'insert' | 'select'>

/**
 * Revision 16: the system accounts migration 0014 creates. Restored after
 * every truncate, so they always exist and keep ids 1-3; a no-op when present.
 */
export async function ensureSystemAccounts(db: Inserter) {
  // Only the missing ones: ON CONFLICT would still use up serial ids, and the
  // provider payables' ids must stay the same on every reseed.
  const existing = await db.select({ code: accounts.code }).from(accounts)
  const missing = Object.values(SYSTEM_ACCOUNTS).filter(
    (account) => !existing.some((row) => row.code === account.code),
  )
  if (missing.length === 0) return
  await db.insert(accounts).values(missing)
}

/**
 * Removes all data and restarts ids so a reseed produces the same ids every
 * time. The ledger's system accounts are put back straight away.
 */
export async function truncateAll(db: Db) {
  await db.execute(sql`truncate table ${ALL_TABLES} restart identity cascade`)
  await ensureSystemAccounts(db)
}

/** A trigger (migration 0014) gives each new provider its payable account. */
async function seedProvider(db: Inserter, seed: SeedProvider) {
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

/** Generated patients on top of the named ones, for a demo-sized patient list. */
const BULK_PATIENT_COUNT = 246

export interface SeedOptions {
  /**
   * The demo seed: the 12 small-stock DEMO_PRODUCTS instead of the named five,
   * and ~250 patients. Off for tests and e2e, on for `db:seed`.
   */
  bulk?: boolean
}

/** Bulk patients alternate between the seeded providers. */
async function seedBulkPatients(db: Inserter, providerIds: number[]) {
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
  db: Inserter,
  options: SeedOptions = {},
): Promise<SeedResult> {
  await ensureSystemAccounts(db)
  const seededProviders = await SEED_PROVIDERS.reduce<
    Promise<SeededProvider[]>
  >(
    async (accP, seed) => [...(await accP), await seedProvider(db, seed)],
    Promise.resolve([]),
  )

  const [admin] = await db
    .insert(users)
    .values({ name: SEED_ADMIN_NAME, role: 'admin' })
    .returning({ id: users.id })

  const seededProducts = await db
    .insert(products)
    .values(options.bulk ? DEMO_PRODUCTS : SEED_PRODUCTS)
    .returning({
      id: products.id,
      cogsCents: products.cogsCents,
      stockQuantity: products.stockQuantity,
    })

  if (options.bulk) {
    await seedBulkPatients(
      db,
      seededProviders.map((p) => p.providerId),
    )
  }

  return {
    providers: seededProviders,
    adminUserId: admin!.id,
    products: seededProducts,
  }
}

/**
 * Loads the full demo seed (named and bulk rows) only if there are no users
 * yet, so a deploy can run it every time without touching live data. Never
 * truncates. The advisory lock makes concurrent runs wait, then see the rows.
 * Returns whether it seeded.
 */
export async function seedIfEmpty(db: Db) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('supplement-orders:seed'))`,
    )
    const existing = await tx.select({ id: users.id }).from(users).limit(1)
    if (existing.length > 0) return false
    await seedDatabase(tx, { bulk: true })
    return true
  })
}
