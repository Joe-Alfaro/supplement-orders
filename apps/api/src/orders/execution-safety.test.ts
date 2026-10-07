import supertest from 'supertest'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { sql } from 'drizzle-orm'
import {
  apiErrorResponseSchema,
  dashboardDtoSchema,
  pageSchema,
  patientOrderDetailDtoSchema,
  productDtoSchema,
} from '@supplement-orders/domain'
import type { ApiErrorCode, OrderLineInput } from '@supplement-orders/domain'
import { RecordingNotifier } from '../seams'
import type { ChargeRequest, ChargeResult, PaymentGateway } from '../seams'
import { FakePaymentGateway } from '../seams'
import { createApp, type PayHooks } from '../server'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  as,
  createSentOrder,
  moneyState,
  pay,
  patientQuote,
  setStock,
} from '../testing/flows'

// Revision 10. The fake gateway is an external durable store (fake_gateway_charges):
// the first call for a key decides, a replay ignores simulateFailure, and lookup
// never charges. Overlapping pays are held at that seam after the real charge
// returns. A fresh gateway plus app on the same database is a restart.

const RECONCILIATION =
  'A payment for this order is being finalized. Try again shortly or contact support.'

interface HttpResult {
  status: number
  body: unknown
}

interface HeldCharge {
  request: ChargeRequest
  result: ChargeResult
  release: () => void
}

interface GatewayChargeRow {
  idempotencyKey: string
  amountCents: number
  status: string
  reference: string | null
}

interface GatewayLookup {
  status: 'succeeded' | 'declined'
  amountCents: number
  reference: string | null
}

type PayResponse = Awaited<ReturnType<typeof pay>>

const holder: { ctx?: InternalTestContext } = {}
let restoreGateway: (() => void) | undefined

function context(): InternalTestContext {
  if (!holder.ctx) throw new Error('test context was not created')
  return holder.ctx
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value as Record<string, unknown>
}

function result(response: { status: number; body: unknown }): HttpResult {
  return { status: response.status, body: response.body }
}

function numberValue(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} was not an integer`)
  }
  return parsed
}

function executionKey(orderId: number, revision: number, execution = 1) {
  return `order-${orderId}-r${revision}-e${execution}`
}

function lineAt(
  ctx: InternalTestContext,
  unitPriceCents: number,
): OrderLineInput[] {
  const product = ctx.seed.products[0]
  if (!product) throw new Error('seed has no product')
  return [{ productId: product.id, quantity: 1, unitPriceCents }]
}

function productIdOf(ctx: InternalTestContext): number {
  const product = ctx.seed.products[0]
  if (!product) throw new Error('seed has no product')
  return product.id
}

function heldAt(held: readonly HeldCharge[], index: number): HeldCharge {
  const charge = held[index]
  if (!charge) throw new Error(`gateway response ${index} was not held`)
  return charge
}

function expectApiError(
  response: HttpResult,
  status: number,
  code: ApiErrorCode,
  message?: string,
) {
  expect(response.status).toBe(status)
  const parsed = apiErrorResponseSchema.parse(response.body)
  expect(parsed.error.code).toBe(code)
  if (message !== undefined) expect(parsed.error.message).toBe(message)
}

function postgresCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  if (typeof code === 'string') return code
  return postgresCode(Reflect.get(error, 'cause'))
}

async function loadGatewayCharges(
  ctx: InternalTestContext,
): Promise<GatewayChargeRow[]> {
  try {
    const query = await ctx.db.execute(sql`
      select
        idempotency_key as "idempotencyKey",
        amount_cents::text as "amountCents",
        status,
        reference
      from fake_gateway_charges
      order by idempotency_key
    `)
    return query.rows.map((row) => {
      const record = asRecord(row)
      const reference = record.reference
      return {
        idempotencyKey: String(record.idempotencyKey),
        amountCents: numberValue(record.amountCents, 'amountCents'),
        status: String(record.status),
        reference: typeof reference === 'string' ? reference : null,
      }
    })
  } catch (error) {
    if (postgresCode(error) === '42P01') {
      throw new Error(
        'fake_gateway_charges does not exist; the fake gateway is not durable',
      )
    }
    throw error
  }
}

function succeededReferences(rows: readonly GatewayChargeRow[]): string[] {
  return rows
    .filter((row) => row.status === 'succeeded')
    .map((row) => {
      if (row.reference === null || row.reference.length === 0) {
        throw new Error(
          `succeeded charge ${row.idempotencyKey} has no reference`,
        )
      }
      return row.reference
    })
    .sort()
}

async function expectRecordedSuccesses(ctx: InternalTestContext) {
  const charges = await loadGatewayCharges(ctx)
  const query = await ctx.db.execute(sql`
    select gateway_reference as "gatewayReference"
    from payments
    order by id
  `)
  const payments = query.rows
    .map((row) => {
      const reference = asRecord(row).gatewayReference
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new Error('payment is missing gatewayReference')
      }
      return reference
    })
    .sort()
  expect(succeededReferences(charges)).toEqual(payments)
  return { charges, payments }
}

async function loadAttempt(orderId: number) {
  const query = await context().db.execute(sql`
    select
      idempotency_key as "idempotencyKey",
      status,
      execution::text as execution,
      amount_cents::text as "amountCents",
      gateway_reference as "gatewayReference",
      stock_held as "stockHeld"
    from payment_attempts
    where order_id = ${orderId}
    order by id
  `)
  return query.rows.map((row) => {
    const record = asRecord(row)
    const gatewayReference = record.gatewayReference
    return {
      idempotencyKey: String(record.idempotencyKey),
      status: String(record.status),
      execution: numberValue(record.execution, 'execution'),
      amountCents: numberValue(record.amountCents, 'amountCents'),
      gatewayReference:
        typeof gatewayReference === 'string' ? gatewayReference : null,
      stockHeld: record.stockHeld === true,
    }
  })
}

function installHold(
  gateway: FakePaymentGateway,
  held: HeldCharge[],
  holdCount: number,
) {
  const original = gateway.charge.bind(gateway)
  gateway.charge = async (request, options) => {
    const outcome = await original(request, options)
    // Later charges (the reprice pay, the competing order) must not wait.
    if (held.length >= holdCount) return outcome
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    held.push({ request, result: outcome, release })
    await released
    return outcome
  }
  restoreGateway = () => {
    gateway.charge = original
    held.forEach((charge) => charge.release())
  }
}

function crashAfterAccept(gateway: FakePaymentGateway) {
  const original = gateway.charge.bind(gateway)
  let accepted: ChargeResult | undefined
  gateway.charge = async (request, options) => {
    const outcome = await original(request, options)
    if (accepted === undefined && outcome.status === 'succeeded') {
      accepted = outcome
      throw new Error('crash after the gateway accepted the charge')
    }
    return outcome
  }
  restoreGateway = () => {
    gateway.charge = original
  }
  return () => {
    if (!accepted) throw new Error('the gateway never accepted a charge')
    return accepted
  }
}

async function waitForHeld(held: readonly HeldCharge[], count: number) {
  const deadline = Date.now() + 5_000
  const poll = async (): Promise<void> => {
    if (held.length >= count) return
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out with ${held.length} held gateway responses, wanted ${count}`,
      )
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await poll()
  }
  await poll()
}

function restarted(ctx: InternalTestContext): InternalTestContext {
  const notifier = new RecordingNotifier()
  const payHooks: PayHooks = {}
  const gateway = new FakePaymentGateway(ctx.db)
  function appFor(next: FakePaymentGateway) {
    return createApp({
      db: ctx.db,
      gateway: next,
      notifier,
      pingDb: async () => {},
      nodeEnv: 'test',
      payHooks,
    })
  }
  const copy: InternalTestContext = {
    seed: ctx.seed,
    db: ctx.db,
    notifier,
    payHooks,
    gateway,
    request: supertest(appFor(gateway)),
    restart() {
      copy.gateway = new FakePaymentGateway(ctx.db)
      copy.request = supertest(appFor(copy.gateway))
      delete payHooks.afterLedgerInsert
    },
    reset: () => Promise.reject(new Error('the restarted app must not reseed')),
    close: () => Promise.resolve(),
  }
  return copy
}

async function beginDeclineOverlap(ctx: InternalTestContext, orderId: number) {
  const held: HeldCharge[] = []
  installHold(ctx.gateway, held, 2)
  const firstPay = pay(ctx, orderId, { simulateFailure: true })
  await waitForHeld(held, 1)
  const secondPay = pay(ctx, orderId)
  await waitForHeld(held, 2)
  return { held, firstPay, secondPay }
}

function expectSameDecline(held: readonly HeldCharge[], orderId: number) {
  const decline = heldAt(held, 0)
  const second = heldAt(held, 1)
  expect(decline.result.status).toBe('failed')
  expect(second.result).toEqual(decline.result)
  expect(second.request.idempotencyKey).toBe(decline.request.idempotencyKey)
  expect(decline.request.idempotencyKey).toBe(executionKey(orderId, 1))
  expect(decline.request.amountCents).toBe(2_000)
}

async function deliver(
  charge: HeldCharge,
  pending: Promise<PayResponse>,
): Promise<HttpResult> {
  charge.release()
  return result(await pending)
}

async function expectBlocked(
  ctx: InternalTestContext,
  orderId: number,
  productId: number,
) {
  const provider = as(ctx.seed.providerUserId)
  const cancel = result(
    await ctx.request.post(`/api/orders/${orderId}/cancel`).set(provider),
  )
  const reopened = result(
    await ctx.request.post(`/api/orders/${orderId}/reopen`).set(provider),
  )
  const removed = result(
    await ctx.request.delete(`/api/orders/${orderId}`).set(provider),
  )
  const edited = result(
    await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(provider)
      .send({ lines: [{ productId, quantity: 1, unitPriceCents: 3_000 }] }),
  )
  const responses = [cancel, reopened, removed, edited]
  responses.forEach((response) => {
    expectApiError(
      response,
      409,
      'PAYMENT_NEEDS_RECONCILIATION',
      RECONCILIATION,
    )
  })
  expect(removed.status).not.toBe(204)
}

async function repriceAndResend(
  ctx: InternalTestContext,
  orderId: number,
  productId: number,
  unitPriceCents: number,
) {
  const provider = as(ctx.seed.providerUserId)
  const cancelled = await ctx.request
    .post(`/api/orders/${orderId}/cancel`)
    .set(provider)
  expect(cancelled.status).toBe(200)
  const reopened = await ctx.request
    .post(`/api/orders/${orderId}/reopen`)
    .set(provider)
  expect(reopened.status).toBe(200)
  const edited = await ctx.request
    .put(`/api/orders/${orderId}/lines`)
    .set(provider)
    .send({ lines: [{ productId, quantity: 1, unitPriceCents }] })
  expect(edited.status).toBe(200)
  const sent = await ctx.request
    .post(`/api/orders/${orderId}/send`)
    .set(provider)
  expect(sent.status).toBe(200)
}

describe('revision 10 execution-safe payments', () => {
  beforeAll(async () => {
    holder.ctx = await createInternalTestContext()
  })

  beforeEach(async () => {
    await context().reset()
  })

  afterEach(() => {
    restoreGateway?.()
    restoreGateway = undefined
  })

  afterAll(async () => {
    await holder.ctx?.close()
  })

  it('N1: a held decline and a second pay share one outcome, and a later quote is charged once', async () => {
    const ctx = context()
    const productId = productIdOf(ctx)
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const quote = await patientQuote(ctx, orderId)
    expect(quote).toEqual({ expectedRevision: 1, expectedTotalCents: 2_000 })
    const before = await moneyState(ctx, orderId)

    const { held, firstPay, secondPay } = await beginDeclineOverlap(
      ctx,
      orderId,
    )
    const reserved = await moneyState(ctx, orderId)
    expect(reserved.payments).toHaveLength(0)
    expect(
      reserved.stock.find((row) => row.id === productId)?.stockQuantity,
    ).toBe(before.stock.find((row) => row.id === productId)!.stockQuantity - 1)

    await expectBlocked(ctx, orderId, productId)
    expectSameDecline(held, orderId)

    const decline = await deliver(heldAt(held, 0), firstPay)
    expectApiError(decline, 402, 'PAYMENT_FAILED')
    const attempts = await loadAttempt(orderId)
    expect(attempts).toEqual([
      expect.objectContaining({
        idempotencyKey: executionKey(orderId, 1),
        execution: 1,
        status: 'declined',
        amountCents: 2_000,
        gatewayReference: null,
        stockHeld: false,
      }),
    ])
    const released = await moneyState(ctx, orderId)
    expect(released.stock).toEqual(before.stock)
    expect(released.payments).toHaveLength(0)

    // Reproduce the audit window: mutate the quote before delivering B.
    // B must be the durable decline too; fabricating a success would bypass
    // the gateway behavior this regression is intended to exercise.
    await repriceAndResend(ctx, orderId, productId, 3_000)
    expectApiError(
      await deliver(heldAt(held, 1), secondPay),
      402,
      'PAYMENT_FAILED',
    )
    const paid = result(await pay(ctx, orderId))
    expect(paid.status).toBe(200)
    const detail = patientOrderDetailDtoSchema.parse(paid.body)
    expect(detail.status).toBe('paid')
    expect(detail.totalCents).toBe(3_000)
    expect(detail.payment?.amountCents).toBe(3_000)

    const recorded = await expectRecordedSuccesses(ctx)
    expect(recorded.payments).toEqual([detail.payment?.reference])
    const rows = await loadGatewayCharges(ctx)
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(1)
    expect(
      rows.find((row) => row.idempotencyKey === executionKey(orderId, 1))
        ?.status,
    ).toBe('declined')
    const after = await moneyState(ctx, orderId)
    expect(after.ledger).toHaveLength(3)
    expect(after.stock.find((row) => row.id === productId)?.stockQuantity).toBe(
      before.stock.find((row) => row.id === productId)!.stockQuantity - 1,
    )
  })

  it('N1 delete: deleting after the authoritative decline leaves no late success behind', async () => {
    const ctx = context()
    const productId = productIdOf(ctx)
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const { held, firstPay, secondPay } = await beginDeclineOverlap(
      ctx,
      orderId,
    )

    await expectBlocked(ctx, orderId, productId)
    expectSameDecline(held, orderId)
    const removedWhileHeld = result(
      await ctx.request
        .delete(`/api/orders/${orderId}`)
        .set(as(ctx.seed.providerUserId)),
    )
    expectApiError(
      removedWhileHeld,
      409,
      'PAYMENT_NEEDS_RECONCILIATION',
      RECONCILIATION,
    )

    expectApiError(
      await deliver(heldAt(held, 0), firstPay),
      402,
      'PAYMENT_FAILED',
    )

    const provider = as(ctx.seed.providerUserId)
    expect(
      (await ctx.request.post(`/api/orders/${orderId}/cancel`).set(provider))
        .status,
    ).toBe(200)
    expect(
      (await ctx.request.post(`/api/orders/${orderId}/reopen`).set(provider))
        .status,
    ).toBe(200)
    const removed = await ctx.request
      .delete(`/api/orders/${orderId}`)
      .set(provider)
    expect(removed.status).toBe(204)
    const late = await deliver(heldAt(held, 1), secondPay)
    expectApiError(late, 404, 'NOT_FOUND')
    expect(await loadAttempt(orderId)).toEqual([])

    const recorded = await expectRecordedSuccesses(ctx)
    expect(recorded.payments).toEqual([])
    const rows = await loadGatewayCharges(ctx)
    expect(rows.map((row) => row.status)).toEqual(['declined'])
    expect(
      rows.every((row) => row.idempotencyKey === executionKey(orderId, 1)),
    ).toBe(true)
  })

  it('N1 last unit: a late decline cannot release stock consumed by a competing order', async () => {
    const ctx = context()
    const productId = productIdOf(ctx)
    const lines = lineAt(ctx, 2_000)
    const orderId = await createSentOrder(ctx, lines)
    const competingId = await createSentOrder(ctx, lines)
    await setStock(ctx, productId, 1)
    const { held, firstPay, secondPay } = await beginDeclineOverlap(
      ctx,
      orderId,
    )

    const blocked = result(await pay(ctx, competingId))
    expectApiError(blocked, 422, 'INSUFFICIENT_STOCK')
    expectSameDecline(held, orderId)

    expectApiError(
      await deliver(heldAt(held, 0), firstPay),
      402,
      'PAYMENT_FAILED',
    )
    const released = await moneyState(ctx, orderId)
    expect(
      released.stock.find((row) => row.id === productId)?.stockQuantity,
    ).toBe(1)
    expect(released.order).toEqual({ status: 'pending_payment', paidAt: null })

    const taken = result(await pay(ctx, competingId))
    expect(taken.status).toBe(200)
    expectApiError(
      await deliver(heldAt(held, 1), secondPay),
      402,
      'PAYMENT_FAILED',
    )
    const detail = patientOrderDetailDtoSchema.parse(taken.body)
    expect(detail.status).toBe('paid')
    expect(detail.payment?.amountCents).toBe(2_000)

    const recorded = await expectRecordedSuccesses(ctx)
    expect(recorded.payments).toEqual([detail.payment?.reference])
    const firstKey = executionKey(orderId, 1)
    const rows = await loadGatewayCharges(ctx)
    expect(rows.find((row) => row.idempotencyKey === firstKey)?.status).toBe(
      'declined',
    )
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(1)
    const after = await moneyState(ctx, competingId)
    expect(after.stock.find((row) => row.id === productId)?.stockQuantity).toBe(
      0,
    )
    expect((await moneyState(ctx, orderId)).payments).toHaveLength(0)
  })

  it('a stale decline cannot release execution 2 while its success is held', async () => {
    const ctx = context()
    const productId = productIdOf(ctx)
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const competingId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    await setStock(ctx, productId, 1)
    const held: HeldCharge[] = []
    installHold(ctx.gateway, held, 3)
    const first = pay(ctx, orderId, { simulateFailure: true })
    await waitForHeld(held, 1)
    const duplicate = pay(ctx, orderId)
    await waitForHeld(held, 2)
    expectSameDecline(held, orderId)
    expectApiError(await deliver(heldAt(held, 0), first), 402, 'PAYMENT_FAILED')

    const next = pay(ctx, orderId)
    await waitForHeld(held, 3)
    expect(heldAt(held, 2).request.idempotencyKey).toBe(
      executionKey(orderId, 1, 2),
    )
    expect(heldAt(held, 2).result.status).toBe('succeeded')
    expectApiError(
      await deliver(heldAt(held, 1), duplicate),
      402,
      'PAYMENT_FAILED',
    )
    await expectBlocked(ctx, orderId, productId)
    expectApiError(
      result(await pay(ctx, competingId)),
      422,
      'INSUFFICIENT_STOCK',
    )
    expect(await loadAttempt(orderId)).toEqual([
      expect.objectContaining({
        execution: 1,
        status: 'declined',
        stockHeld: false,
      }),
      expect.objectContaining({
        execution: 2,
        status: 'pending',
        stockHeld: true,
      }),
    ])

    expect((await deliver(heldAt(held, 2), next)).status).toBe(200)
    const recorded = await expectRecordedSuccesses(ctx)
    expect(recorded.payments).toEqual([heldAt(held, 2).result.reference])
    const state = await moneyState(ctx, orderId)
    expect(state.stock.find((row) => row.id === productId)?.stockQuantity).toBe(
      0,
    )
    expect(state.ledger).toHaveLength(3)
  })

  it('N2: a fresh gateway completes a persisted success without a second charge', async () => {
    const ctx = context()
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const before = await moneyState(ctx, orderId)
    ctx.payHooks.afterLedgerInsert = async () => {
      throw new Error('boom after ledger insert')
    }

    const failed = result(await pay(ctx, orderId))
    expectApiError(failed, 500, 'INTERNAL')
    delete ctx.payHooks.afterLedgerInsert
    const pending = await moneyState(ctx, orderId)
    expect(pending.payments).toHaveLength(0)
    expect(
      pending.stock.find((row) => row.id === productIdOf(ctx))?.stockQuantity,
    ).toBe(
      before.stock.find((row) => row.id === productIdOf(ctx))!.stockQuantity -
        1,
    )

    const fresh = restarted(ctx)
    const retry = result(await pay(fresh, orderId))
    expect(fresh.gateway.charges).toEqual([])
    expect(retry.status).toBe(200)
    const detail = patientOrderDetailDtoSchema.parse(retry.body)
    expect(detail.status).toBe('paid')
    expect(detail.payment?.amountCents).toBe(2_000)
    const again = result(await pay(restarted(ctx), orderId))
    expect(again.status).toBe(200)
    expect(patientOrderDetailDtoSchema.parse(again.body).payment).toEqual(
      detail.payment,
    )

    const recorded = await expectRecordedSuccesses(ctx)
    expect(recorded.payments).toEqual([detail.payment?.reference])
    const rows = await loadGatewayCharges(ctx)
    expect(rows).toEqual([
      expect.objectContaining({
        idempotencyKey: executionKey(orderId, 1),
        amountCents: 2_000,
        status: 'succeeded',
        reference: detail.payment?.reference,
      }),
    ])
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toHaveLength(1)
    expect(after.ledger).toHaveLength(3)
    expect(after.stock).toEqual(pending.stock)
  })

  it('N2: a fresh gateway replays a charge that succeeded before its result was saved', async () => {
    const ctx = context()
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const accepted = crashAfterAccept(ctx.gateway)

    const failed = result(await pay(ctx, orderId))
    expectApiError(failed, 500, 'INTERNAL')
    const reference = accepted().reference
    expect(reference.length).toBeGreaterThan(0)
    const pending = await moneyState(ctx, orderId)
    expect(pending.payments).toHaveLength(0)
    expect(pending.order).toEqual({ status: 'pending_payment', paidAt: null })

    const retry = result(await pay(restarted(ctx), orderId))
    expect(retry.status).toBe(200)
    const detail = patientOrderDetailDtoSchema.parse(retry.body)
    expect(detail.payment?.reference).toBe(reference)
    expect(detail.payment?.amountCents).toBe(2_000)

    const recorded = await expectRecordedSuccesses(ctx)
    expect(recorded.payments).toEqual([reference])
    const rows = await loadGatewayCharges(ctx)
    expect(
      rows
        .filter((row) => row.status === 'succeeded')
        .map((row) => row.reference),
    ).toEqual([reference])
  })

  it.each(['missing', 'declined', 'amount', 'reference'] as const)(
    'a succeeded retry refuses lookup inconsistency (%s) without charging',
    async (mismatch) => {
      const ctx = context()
      const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
      ctx.payHooks.afterLedgerInsert = async () => {
        throw new Error('rollback before payment commit')
      }
      expectApiError(result(await pay(ctx, orderId)), 500, 'INTERNAL')
      const before = await moneyState(ctx, orderId)
      const key = executionKey(orderId, 1)
      if (mismatch === 'missing') {
        await ctx.db.execute(
          sql`delete from fake_gateway_charges where idempotency_key = ${key}`,
        )
      } else if (mismatch === 'declined') {
        await ctx.db.execute(
          sql`update fake_gateway_charges set status = 'declined', reference = null where idempotency_key = ${key}`,
        )
      } else if (mismatch === 'amount') {
        await ctx.db.execute(
          sql`update fake_gateway_charges set amount_cents = 1999 where idempotency_key = ${key}`,
        )
      } else {
        await ctx.db.execute(
          sql`update fake_gateway_charges set reference = 'different-reference' where idempotency_key = ${key}`,
        )
      }
      const fresh = restarted(ctx)
      expectApiError(
        result(await pay(fresh, orderId)),
        409,
        'PAYMENT_NEEDS_RECONCILIATION',
        RECONCILIATION,
      )
      expect(fresh.gateway.charges).toEqual([])
      expect(await moneyState(ctx, orderId)).toEqual(before)
      await expectBlocked(fresh, orderId, productIdOf(ctx))
    },
  )

  it('N3: a key conflict keeps the reservation and blocks cancel, reopen and delete', async () => {
    const ctx = context()
    const productId = productIdOf(ctx)
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const before = await moneyState(ctx, orderId)
    const key = executionKey(orderId, 1)
    const bound = await ctx.gateway.charge({
      amountCents: 1_999,
      idempotencyKey: key,
      description: `Supplement order ${orderId} (revision 1)`,
    })
    expect(bound.status).toBe('succeeded')
    expect(bound.reference.length).toBeGreaterThan(0)

    const rejected = result(await pay(ctx, orderId))
    expectApiError(
      rejected,
      409,
      'PAYMENT_NEEDS_RECONCILIATION',
      RECONCILIATION,
    )
    const state = await moneyState(ctx, orderId)
    expect(state.payments).toHaveLength(0)
    expect(state.ledger).toHaveLength(0)
    expect(state.order).toEqual({ status: 'pending_payment', paidAt: null })
    expect(state.stock.find((row) => row.id === productId)?.stockQuantity).toBe(
      before.stock.find((row) => row.id === productId)!.stockQuantity - 1,
    )
    await expectBlocked(ctx, orderId, productId)
    const attempts = await loadAttempt(orderId)
    expect(attempts).toEqual([
      expect.objectContaining({
        idempotencyKey: key,
        execution: 1,
        status: 'conflict',
        amountCents: 2_000,
        stockHeld: true,
        gatewayReference: null,
      }),
    ])
    const rows = await loadGatewayCharges(ctx)
    expect(rows).toEqual([
      expect.objectContaining({
        idempotencyKey: key,
        amountCents: 1_999,
        status: 'succeeded',
        reference: bound.reference,
      }),
    ])
    expect((await moneyState(ctx, orderId)).payments).toHaveLength(0)
  })

  describe('durable gateway replay and lookup', () => {
    it('replays a success when the second call asks to simulate failure', async () => {
      const ctx = context()
      const key = 'order-4-r2-e1'
      const request = {
        idempotencyKey: key,
        description: 'Supplement order 4 (revision 2)',
      }
      const first = await ctx.gateway.charge({ ...request, amountCents: 2_000 })
      expect(first.status).toBe('succeeded')
      const second = await ctx.gateway.charge(
        { ...request, amountCents: 2_000 },
        { simulateFailure: true },
      )
      expect(second).toEqual(first)

      const mismatch = await ctx.gateway.charge({
        ...request,
        amountCents: 1_999,
      })
      expect(mismatch.status).toBe('failed')
      expect(mismatch.failureMessage).toBe('IDEMPOTENCY_KEY_REUSED')

      const rows = await loadGatewayCharges(ctx)
      expect(rows).toEqual([
        {
          idempotencyKey: key,
          amountCents: 2_000,
          status: 'succeeded',
          reference: first.reference,
        },
      ])
    })

    it('replays a stored decline instead of charging on the next call', async () => {
      const ctx = context()
      const key = 'order-5-r1-e1'
      const request = {
        idempotencyKey: key,
        amountCents: 2_000,
        description: 'Supplement order 5 (revision 1)',
      }
      const first = await ctx.gateway.charge(request, { simulateFailure: true })
      expect(first.status).toBe('failed')
      const second = await ctx.gateway.charge(request)
      expect(second.status).toBe('failed')
      expect(second.reference).toBe(first.reference)
      expect(second.failureMessage).toBe(first.failureMessage)

      const rows = await loadGatewayCharges(ctx)
      expect(rows).toEqual([
        {
          idempotencyKey: key,
          amountCents: 2_000,
          status: 'declined',
          reference: null,
        },
      ])
    })

    it('atomically binds one outcome across freshly constructed gateways', async () => {
      const ctx = context()
      const gateways = Array.from(
        { length: 8 },
        () => new FakePaymentGateway(ctx.db),
      )
      const request = {
        idempotencyKey: 'order-8-r1-e1',
        amountCents: 2_000,
        description: 'Concurrent gateway instances',
      }
      const outcomes = await Promise.all(
        gateways.map((gateway, index) =>
          gateway.charge({ ...request, simulateFailure: index % 2 === 0 }),
        ),
      )
      outcomes.forEach((outcome) => expect(outcome).toEqual(outcomes[0]))
      const rows = await loadGatewayCharges(ctx)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe(
        outcomes[0]?.status === 'succeeded' ? 'succeeded' : 'declined',
      )
      expect(rows[0]?.reference).toBe(outcomes[0]?.reference || null)
      const fresh = new FakePaymentGateway(ctx.db)
      expect(await fresh.charge(request)).toEqual(outcomes[0])
      expect(await loadGatewayCharges(ctx)).toEqual(rows)
    })

    it('looks up a charge without charging, and misses an unknown key', async () => {
      const ctx = context()
      const key = 'order-6-r1-e1'
      const first = await ctx.gateway.charge({
        idempotencyKey: key,
        amountCents: 2_000,
        description: 'Supplement order 6 (revision 1)',
      })
      expect(first.status).toBe('succeeded')
      const declinedKey = 'order-7-r1-e1'
      await ctx.gateway.charge({
        idempotencyKey: declinedKey,
        amountCents: 2_000,
        description: 'Declined lookup',
        simulateFailure: true,
      })
      const rowsBefore = await loadGatewayCharges(ctx)
      const callsBefore = ctx.gateway.charges.length

      const found = await lookupCharge(ctx.gateway, key)
      const missing = await lookupCharge(ctx.gateway, 'order-6-r1-e2')

      expect(found).toEqual({
        status: 'succeeded',
        amountCents: 2_000,
        reference: first.reference,
      })
      expect(missing).toBeNull()
      expect(await ctx.gateway.lookup(declinedKey)).toEqual({
        status: 'declined',
        amountCents: 2_000,
        reference: null,
      })
      expect(ctx.gateway.charges).toHaveLength(callsBefore)
      const rows = await loadGatewayCharges(ctx)
      expect(rows).toEqual(rowsBefore)
      expect(rows).toHaveLength(2)
      expect(rows[0]?.reference).toBe(first.reference)
    })
  })

  it('a retried pay after a 500 completes with one charge', async () => {
    const ctx = context()
    const productId = productIdOf(ctx)
    const orderId = await createSentOrder(ctx, lineAt(ctx, 2_000))
    const provider = as(ctx.seed.providerUserId)
    const stockBefore = pageSchema(productDtoSchema)
      .parse(
        (await ctx.request.get('/api/products?limit=100').set(provider)).body,
      )
      .items.find((item) => item.id === productId)?.stockQuantity
    ctx.payHooks.afterLedgerInsert = async () => {
      throw new Error('boom after ledger insert')
    }

    const failed = result(await pay(ctx, orderId))
    expectApiError(failed, 500, 'INTERNAL')

    const restartedApp = restarted(ctx)
    const retry = result(await pay(restartedApp, orderId))
    expect(retry.status).toBe(200)
    const detail = patientOrderDetailDtoSchema.parse(retry.body)
    expect(detail.status).toBe('paid')
    expect(detail.revision).toBe(1)
    expect(detail.totalCents).toBe(2_000)
    expect(detail.payment?.amountCents).toBe(2_000)

    const again = result(await pay(restartedApp, orderId))
    expect(again.status).toBe(200)
    expect(patientOrderDetailDtoSchema.parse(again.body).payment).toEqual(
      detail.payment,
    )
    const dashboard = dashboardDtoSchema.parse(
      (await restartedApp.request.get('/api/dashboard').set(provider)).body,
    )
    expect(dashboard.gmvCents).toBe(2_000)
    const stockAfter = pageSchema(productDtoSchema)
      .parse(
        (
          await restartedApp.request
            .get('/api/products?limit=100')
            .set(provider)
        ).body,
      )
      .items.find((item) => item.id === productId)?.stockQuantity
    expect(stockAfter).toBe((stockBefore ?? 0) - 1)

    const rows = await loadGatewayCharges(ctx)
    expect(succeededReferences(rows)).toEqual([detail.payment?.reference])
  })
})

async function lookupCharge(
  gateway: PaymentGateway,
  idempotencyKey: string,
): Promise<GatewayLookup | null> {
  const method = Reflect.get(gateway, 'lookup')
  if (typeof method !== 'function') {
    throw new Error('PaymentGateway.lookup is missing')
  }
  const resultUnknown: unknown = method.call(gateway, idempotencyKey)
  if (!(resultUnknown instanceof Promise)) {
    throw new Error('PaymentGateway.lookup must return a promise')
  }
  const value: unknown = await resultUnknown
  if (value === null) return null
  const record = asRecord(value)
  const reference = record.reference
  const status = record.status
  if (status !== 'succeeded' && status !== 'declined') {
    throw new Error('lookup status must be succeeded or declined')
  }
  return {
    status,
    amountCents: numberValue(record.amountCents, 'amountCents'),
    reference: typeof reference === 'string' ? reference : null,
  }
}
