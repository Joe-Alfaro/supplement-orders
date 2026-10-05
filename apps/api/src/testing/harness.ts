import pg from 'pg'
import supertest from 'supertest'
import { createDb, type Db } from '../db/client'
import { runMigrations } from '../db/migrate'
import { seedDatabase, truncateAll, type SeedResult } from '../db/seed'
import { FakePaymentGateway, RecordingNotifier } from '../seams'
import { createApp, type PayHooks } from '../server'

// Contract: notes/DOMAIN_CONTRACT.md "API test harness". Black-box HTTP tests use
// createTestContext(); white-box API tests may use createInternalTestContext().

export interface SeedIds {
  /** Owns patientId. */
  providerUserId: number
  /** Owns no patients of the first provider. */
  otherProviderUserId: number
  /** Patient profile = patientId. */
  patientUserId: number
  /** A different patient of the same provider. */
  otherPatientUserId: number
  patientId: number
  /** At least 3, each with stock >= 10. */
  products: { id: number; cogsCents: number; stockQuantity: number }[]
}

export interface TestContext {
  /** Bound to the app; tests set X-User-Id per call. */
  request: supertest.Agent
  seed: SeedIds
  /** Truncate + reseed; call in beforeEach. Ids are identical after every reset. */
  reset(): Promise<void>
  /** Call in afterAll. */
  close(): Promise<void>
}

export interface InternalTestContext extends TestContext {
  db: Db
  gateway: FakePaymentGateway
  notifier: RecordingNotifier
  /** Mutable: assign hooks in a test; reset() clears them. */
  payHooks: PayHooks
}

const DEFAULT_ADMIN_URL = 'postgres://supplement_orders:supplement_orders@localhost:54329/supplement_orders'
const TEST_DB_NAME = 'supplement_orders_test'

function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL)
  url.pathname = `/${TEST_DB_NAME}`
  return url.toString()
}

/** Creates the dedicated test database if needed so tests never touch dev data. */
async function ensureTestDatabase(url: string) {
  const target = new URL(url)
  const dbName = target.pathname.slice(1)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    const existing = await client.query(
      'select 1 from pg_database where datname = $1',
      [dbName],
    )
    if (existing.rowCount === 0) {
      await client.query(`create database "${dbName.replaceAll('"', '""')}"`)
    }
  } finally {
    await client.end()
  }
}

function toSeedIds(result: SeedResult): SeedIds {
  const [provider, otherProvider] = result.providers
  const patient = provider?.patients[0]
  const otherPatient = provider?.patients[1]
  if (!provider || !otherProvider || !patient || !otherPatient) {
    throw new Error('Seed data does not satisfy the test harness contract')
  }
  return {
    providerUserId: provider.userId,
    otherProviderUserId: otherProvider.userId,
    patientUserId: patient.userId,
    otherPatientUserId: otherPatient.userId,
    patientId: patient.patientId,
    products: result.products,
  }
}

export async function createInternalTestContext(): Promise<InternalTestContext> {
  const url = testDatabaseUrl()
  await ensureTestDatabase(url)
  const { db, pool, ping } = createDb(url)
  await runMigrations(db)

  const gateway = new FakePaymentGateway()
  const notifier = new RecordingNotifier()
  const payHooks: PayHooks = {}
  const app = createApp({
    db,
    gateway,
    notifier,
    pingDb: ping,
    nodeEnv: 'test',
    payHooks,
  })

  async function reseed() {
    await truncateAll(db)
    return toSeedIds(await seedDatabase(db))
  }

  const ctx: InternalTestContext = {
    request: supertest(app),
    seed: await reseed(),
    db,
    gateway,
    notifier,
    payHooks,
    async reset() {
      ctx.seed = await reseed()
      gateway.failNextCharges = false
      gateway.charges.length = 0
      notifier.sent.length = 0
      delete payHooks.afterLedgerInsert
    },
    async close() {
      await pool.end()
    },
  }
  return ctx
}

export async function createTestContext(): Promise<TestContext> {
  return createInternalTestContext()
}
