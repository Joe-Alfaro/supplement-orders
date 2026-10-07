import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { fakeGatewayCharges } from '../db/schema'

export interface ChargeRequest {
  amountCents: number
  /**
   * One key per payment execution. The gateway charges a key at most once:
   * every later call with the same key and amount replays the first outcome,
   * and the same key with another amount is refused.
   */
  idempotencyKey: string
  description: string
  /** Force a decline on the first call for this key. Honored by the fake only. */
  simulateFailure?: boolean
}

/** failureMessage of a key already bound to another amount. */
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED'

export interface ChargeResult {
  status: 'succeeded' | 'failed'
  /** The charge reference; empty unless succeeded. */
  reference: string
  /** The amount the key is bound to: what was (or would have been) charged. */
  amountCents?: number
  /**
   * Why a charge failed: IDEMPOTENCY_KEY_REUSED for a key bound to another
   * amount, otherwise a decline message safe to show to the payer.
   */
  failureMessage?: string
}

export interface ChargeOptions {
  /** Same as ChargeRequest.simulateFailure. */
  simulateFailure?: boolean
}

/** What the gateway already decided for a key. Looking it up never charges. */
export interface ChargeLookup {
  status: 'succeeded' | 'declined'
  amountCents: number
  /** Null for a decline. */
  reference: string | null
}

export interface PaymentGateway {
  charge(request: ChargeRequest, options?: ChargeOptions): Promise<ChargeResult>
  lookup(idempotencyKey: string): Promise<ChargeLookup | null>
}

const DECLINE_MESSAGE = 'Card declined (simulated gateway failure)'

/**
 * The database a FakePaymentGateway constructed without one uses. The test
 * harness registers its database here, so a freshly constructed gateway
 * (`new FakePaymentGateway()`, as after a restart) reaches the same durable
 * store, like a second process talking to the same external processor.
 */
const fakeGatewayHome: { db: Db | null } = { db: null }

export function useFakeGatewayDatabase(db: Db) {
  fakeGatewayHome.db = db
}

type StoredCharge = typeof fakeGatewayCharges.$inferSelect

function asResult(stored: StoredCharge): ChargeResult {
  if (stored.status === 'succeeded' && stored.reference !== null) {
    return {
      status: 'succeeded',
      reference: stored.reference,
      amountCents: stored.amountCents,
    }
  }
  return {
    status: 'failed',
    reference: '',
    amountCents: stored.amountCents,
    failureMessage: DECLINE_MESSAGE,
  }
}

/**
 * Stand-in for a card processor with durable, Stripe-style idempotency
 * (revision 10). Its state lives in fake_gateway_charges, written in its own
 * committed statements and never inside the API's transactions, so it behaves
 * like an external system: it survives restarts and is shared by every API
 * process. The first call for a key decides the outcome atomically (insert or
 * get); later calls with the same key and amount replay it, decline included.
 */
export class FakePaymentGateway implements PaymentGateway {
  /** Forces first calls to decline while true (for tests and demos). */
  failNextCharges = false
  /** Every charge call, in order (for tests); lookups are not charges. */
  readonly charges: ChargeRequest[] = []

  constructor(private readonly explicitDb?: Db) {}

  private get db(): Db {
    const db = this.explicitDb ?? fakeGatewayHome.db
    if (!db) {
      throw new Error(
        'FakePaymentGateway needs a database: pass one or call useFakeGatewayDatabase',
      )
    }
    return db
  }

  /** Clears the in-process call log; the durable store is the test's to truncate. */
  reset() {
    this.failNextCharges = false
    this.charges.length = 0
  }

  async charge(
    request: ChargeRequest,
    options: ChargeOptions = {},
  ): Promise<ChargeResult> {
    this.charges.push(request)
    const decline =
      this.failNextCharges ||
      request.simulateFailure === true ||
      options.simulateFailure === true
    // First call decides: only one insert can win for a key, even across processes.
    const [inserted] = await this.db
      .insert(fakeGatewayCharges)
      .values({
        idempotencyKey: request.idempotencyKey,
        amountCents: request.amountCents,
        status: decline ? 'declined' : 'succeeded',
        reference: decline ? null : `fake_ch_${randomUUID()}`,
      })
      .onConflictDoNothing({ target: fakeGatewayCharges.idempotencyKey })
      .returning()
    const stored = inserted ?? (await this.find(request.idempotencyKey))
    if (!stored) {
      throw new Error(`Fake gateway lost key ${request.idempotencyKey}`)
    }
    if (stored.amountCents !== request.amountCents) {
      return {
        status: 'failed',
        reference: '',
        amountCents: stored.amountCents,
        failureMessage: IDEMPOTENCY_KEY_REUSED,
      }
    }
    return asResult(stored)
  }

  async lookup(idempotencyKey: string): Promise<ChargeLookup | null> {
    const stored = await this.find(idempotencyKey)
    if (!stored) return null
    return {
      status: stored.status,
      amountCents: stored.amountCents,
      reference: stored.reference,
    }
  }

  private async find(idempotencyKey: string) {
    const [row] = await this.db
      .select()
      .from(fakeGatewayCharges)
      .where(eq(fakeGatewayCharges.idempotencyKey, idempotencyKey))
    return row
  }
}

/** Every successful charge reference the fake gateway holds (for tests and audits). */
export async function fakeGatewaySucceededReferences(db: Db) {
  const rows = await db
    .select({ reference: fakeGatewayCharges.reference })
    .from(fakeGatewayCharges)
    .where(sql`${fakeGatewayCharges.status} = 'succeeded'`)
  return rows.flatMap((r) => (r.reference === null ? [] : [r.reference]))
}
