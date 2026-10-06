import { fileURLToPath } from 'node:url'
import supertest from 'supertest'
import { createDb, type Db } from '../db/client'
import { ensureDatabase, testDatabaseUrl } from '../db/databases'
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

/** This checkout's root; its path keys the test database when no session id is set. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

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

export interface InternalTestOptions {
  /** NODE_ENV the app sees; defaults to 'test'. */
  nodeEnv?: string
}

export async function createInternalTestContext(
  options: InternalTestOptions = {},
): Promise<InternalTestContext> {
  const url = testDatabaseUrl(process.env, REPO_ROOT)
  await ensureDatabase(url)
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
    nodeEnv: options.nodeEnv ?? 'test',
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
      gateway.reset()
      notifier.sent.length = 0
      notifier.cancelled.length = 0
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
