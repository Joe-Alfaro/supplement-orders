import { fileURLToPath } from 'node:url'
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
import pg from 'pg'
import {
  apiErrorResponseSchema,
  providerOrderDetailDtoSchema,
} from '@supplement-orders/domain'
import type { ApiErrorCode, PayOrderRequest } from '@supplement-orders/domain'
import { FakePaymentGateway } from '../seams'
import type { ChargeResult } from '../seams'
import { testDatabaseUrl } from '../db/databases'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  as,
  createSentOrder,
  moneyState,
  pay,
  setStock,
} from '../testing/flows'

// Revision 9, white-box. A succeeded charge whose payment did not commit stays
// unreconciled under order-<id>-r<revision>-e<execution>, with its stock still reserved.
// The same key and amount finishes it and does not take that stock again.
// The same key with another amount is IDEMPOTENCY_KEY_REUSED and never a
// success. Stock rows are locked in product-id order, so reversed lines cannot
// deadlock.

const RECONCILIATION =
  'A payment for this order is being finalized. Try again shortly or contact support.'

const STOCK_GATE = 8_800_1001
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

interface HttpResult {
  status: number
  body: unknown
}

interface Attempt {
  id: number
  orderId: number
  revision: number
  idempotencyKey: string
  amountCents: number
  status: string
  gatewayReference: string | null
}

interface Unreconciled {
  orderId: number
  revision: number
  totalCents: number
  attempt: Attempt
  stock: { id: number; stockQuantity: number }[]
}

interface LockCounts {
  advisoryWaiters: number
  rowWaiters: number
}

interface PricedLines {
  lines: { productId: number; quantity: number; unitPriceCents: number }[]
  totalCents: number
}

const holder: { ctx?: InternalTestContext } = {}

function context(): InternalTestContext {
  if (!holder.ctx) {
    throw new Error('test context was not created')
  }
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

function clearGatewayMemory(gateway: FakePaymentGateway): void {
  const memory: unknown = Reflect.get(gateway, 'byKey')
  if (memory instanceof Map) {
    memory.clear()
  }
}

function quoteFrom(body: unknown): PayOrderRequest {
  const detail = providerOrderDetailDtoSchema.parse(body)
  if (detail.split === null) {
    throw new Error('sent order has no total')
  }
  return {
    expectedRevision: detail.revision,
    expectedTotalCents: detail.split.totalCents,
  }
}

async function providerDetail(orderId: number): Promise<HttpResult> {
  return result(
    await context()
      .request.get(`/api/orders/${orderId}`)
      .set(as(context().seed.providerUserId)),
  )
}

function payBody(
  expectedRevision: number,
  expectedTotalCents: number,
): PayOrderRequest {
  return { expectedRevision, expectedTotalCents }
}

async function loadAttempts(orderId: number): Promise<Attempt[]> {
  const query = await context().db.execute(sql`
    select
      id::text as id,
      order_id::text as "orderId",
      revision::text as revision,
      idempotency_key as "idempotencyKey",
      amount_cents::text as "amountCents",
      status,
      gateway_reference as "gatewayReference"
    from payment_attempts
    where order_id = ${orderId}
    order by id
  `)
  return query.rows.map((row) => {
    const record = asRecord(row)
    const gatewayReference = record.gatewayReference
    return {
      id: numberValue(record.id, 'id'),
      orderId: numberValue(record.orderId, 'orderId'),
      revision: numberValue(record.revision, 'revision'),
      idempotencyKey: String(record.idempotencyKey),
      amountCents: numberValue(record.amountCents, 'amountCents'),
      status: String(record.status),
      gatewayReference:
        typeof gatewayReference === 'string' ? gatewayReference : null,
    }
  })
}

async function loadPaymentLink(orderId: number): Promise<{
  amountCents: number
  gatewayReference: string
  paymentAttemptId: number
}> {
  const query = await context().db.execute(sql`
    select
      amount_cents::text as "amountCents",
      gateway_reference as "gatewayReference",
      payment_attempt_id::text as "paymentAttemptId"
    from payments
    where order_id = ${orderId}
  `)
  const [row] = query.rows
  if (!row) {
    throw new Error(`order ${orderId} has no payment`)
  }
  const record = asRecord(row)
  const gatewayReference = record.gatewayReference
  if (typeof gatewayReference !== 'string' || gatewayReference.length === 0) {
    throw new Error('payment is missing gatewayReference')
  }
  return {
    amountCents: numberValue(record.amountCents, 'amountCents'),
    gatewayReference,
    paymentAttemptId: numberValue(record.paymentAttemptId, 'paymentAttemptId'),
  }
}

function expectApiError(
  response: HttpResult,
  status: number,
  code: ApiErrorCode,
  message?: string,
): void {
  expect(response.status).toBe(status)
  const parsed = apiErrorResponseSchema.parse(response.body)
  expect(parsed.error.code).toBe(code)
  if (message !== undefined) {
    expect(parsed.error.message).toBe(message)
  }
  expect(parsed.error.field).toBeUndefined()
  expect(Object.keys(asRecord(response.body))).toEqual(['error'])
  expect(Object.keys(asRecord(asRecord(response.body).error)).sort()).toEqual([
    'code',
    'message',
  ])
}

function expectReconciliation(response: HttpResult): void {
  expectApiError(response, 409, 'PAYMENT_NEEDS_RECONCILIATION', RECONCILIATION)
}

async function unreconciledCharge(): Promise<Unreconciled> {
  const ctx = context()
  const orderId = await createSentOrder(ctx)
  const detail = await providerDetail(orderId)
  expect(detail.status).toBe(200)
  const quote = quoteFrom(detail.body)
  expect(quote.expectedRevision).toBe(1)
  const { expectedRevision: revision, expectedTotalCents: totalCents } = quote
  const before = await moneyState(ctx, orderId)
  ctx.payHooks.afterLedgerInsert = async () => {
    throw new Error('boom after ledger insert')
  }

  const failed = result(await pay(ctx, orderId, payBody(revision, totalCents)))

  expectApiError(failed, 500, 'INTERNAL')
  const attempts = await loadAttempts(orderId)
  expect(attempts).toHaveLength(1)
  const attempt = attempts[0]
  if (!attempt) {
    throw new Error('succeeded attempt was not stored')
  }
  expect(attempt).toMatchObject({
    orderId,
    revision,
    idempotencyKey: `order-${orderId}-r${revision}-e1`,
    amountCents: totalCents,
    status: 'succeeded',
  })
  expect(attempt.gatewayReference).toEqual(expect.any(String))
  expect(attempt.gatewayReference?.length).toBeGreaterThan(0)
  const state = await moneyState(ctx, orderId)
  expect(state.payments).toHaveLength(0)
  expect(state.ledger).toHaveLength(0)
  expect(state.order).toEqual({ status: 'pending_payment', paidAt: null })
  const reserved = stockHeldFor(before.stock, orderedQuantities(detail.body))
  expect(state.stock).toEqual(reserved)
  expect(ctx.gateway.charges).toEqual([
    expect.objectContaining({
      amountCents: totalCents,
      idempotencyKey: attempt.idempotencyKey,
    }),
  ])
  return {
    orderId,
    revision,
    totalCents,
    attempt,
    stock: reserved,
  }
}

function databaseUrl(): string {
  return testDatabaseUrl(process.env, REPO_ROOT)
}

async function withGateClient<T>(
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

async function dropStockGate(): Promise<void> {
  await withGateClient(async (client) => {
    await client.query(
      'drop trigger if exists test_payment_stock_gate on products',
    )
    await client.query('drop function if exists test_payment_stock_gate()')
  })
}

async function installStockGate(client: pg.Client): Promise<void> {
  await client.query(
    'drop trigger if exists test_payment_stock_gate on products',
  )
  await client.query('drop function if exists test_payment_stock_gate()')
  await client.query(`
    create function test_payment_stock_gate() returns trigger
    language plpgsql as $fn$
    begin
      if coalesce(current_setting('test.stock_gate_seen', true), '') = '' then
        perform set_config('test.stock_gate_seen', '1', true);
        perform pg_advisory_lock(${STOCK_GATE}::bigint);
        perform pg_advisory_unlock(${STOCK_GATE}::bigint);
      end if;
      return new;
    end;
    $fn$
  `)
  await client.query(`
    create trigger test_payment_stock_gate
    before update on products
    for each row
    execute function test_payment_stock_gate()
  `)
}

async function lockCounts(client: pg.Client): Promise<LockCounts> {
  const advisory = await client.query<{ n: number }>(
    `select count(*)::int as n
     from pg_locks
     where locktype = 'advisory'
       and not granted
       and objsubid = 1
       and classid = 0
       and objid = $1`,
    [STOCK_GATE],
  )
  const rows = await client.query<{ n: number }>(
    `select count(*)::int as n
     from pg_locks waiter
     left join pg_class rel on rel.oid = waiter.relation
     where not waiter.granted
       and (
         (waiter.locktype = 'tuple' and rel.relname = 'products')
         or waiter.locktype = 'transactionid'
       )`,
  )
  return {
    advisoryWaiters: advisory.rows[0]?.n ?? 0,
    rowWaiters: rows.rows[0]?.n ?? 0,
  }
}

async function waitForStockOverlap(
  client: pg.Client,
  pending: Promise<unknown>,
): Promise<void> {
  let settled = false
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const deadline = Date.now() + 5_000
  async function poll(): Promise<void> {
    if (settled) return
    const counts = await lockCounts(client)
    if (settled) return
    const overlapped = counts.advisoryWaiters >= 2 || counts.rowWaiters >= 1
    if (overlapped) return
    if (Date.now() >= deadline) {
      throw new Error(
        `stock overlap did not form (advisoryWaiters=${counts.advisoryWaiters}, rowWaiters=${counts.rowWaiters})`,
      )
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    return poll()
  }
  await poll()
}

function pricedLines(
  products: readonly { id: number; cogsCents: number }[],
): PricedLines {
  const lines = products.map((product) => ({
    productId: product.id,
    quantity: 1,
    unitPriceCents: product.cogsCents + 1_000,
  }))
  return {
    lines,
    totalCents: lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPriceCents,
      0,
    ),
  }
}

function orderedQuantities(
  body: unknown,
): { productId: number; quantity: number }[] {
  const lines = asRecord(body).lines
  if (!Array.isArray(lines)) {
    throw new Error('sent order has no lines')
  }
  return lines.map((line) => {
    const record = asRecord(line)
    const productId = record.productId
    if (typeof productId !== 'number') {
      throw new Error('sent line is missing productId')
    }
    return {
      productId,
      quantity: numberValue(record.quantity, 'quantity'),
    }
  })
}

function stockHeldFor(
  before: readonly { id: number; stockQuantity: number }[],
  lines: readonly { productId: number; quantity: number }[],
): { id: number; stockQuantity: number }[] {
  return before.map((row) => {
    const quantity = lines
      .filter((line) => line.productId === row.id)
      .reduce((sum, line) => sum + line.quantity, 0)
    return { id: row.id, stockQuantity: row.stockQuantity - quantity }
  })
}

function stockOf(
  stock: readonly { id: number; stockQuantity: number }[],
  productId: number,
): number {
  const row = stock.find((item) => item.id === productId)
  if (!row) {
    throw new Error(`product ${productId} is missing from stock`)
  }
  return row.stockQuantity
}

describe('payment integrity inside the order service', () => {
  beforeAll(async () => {
    holder.ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await context().reset()
    clearGatewayMemory(context().gateway)
  })
  afterAll(async () => {
    await dropStockGate()
    await context().close()
  })

  it('keeps a succeeded attempt when the main transaction fails and blocks changes', async () => {
    const ctx = context()
    const pending = await unreconciledCharge()
    const lines = (await providerDetail(pending.orderId)).body
    const currentLines = asRecord(lines).lines

    const provider = as(ctx.seed.providerUserId)
    const product = ctx.seed.products[0]
    if (!product) {
      throw new Error('seed has no product')
    }
    const cancelled = result(
      await ctx.request
        .post(`/api/orders/${pending.orderId}/cancel`)
        .set(provider),
    )
    const reopened = result(
      await ctx.request
        .post(`/api/orders/${pending.orderId}/reopen`)
        .set(provider),
    )
    const removed = result(
      await ctx.request.delete(`/api/orders/${pending.orderId}`).set(provider),
    )
    const edited = result(
      await ctx.request
        .put(`/api/orders/${pending.orderId}/lines`)
        .set(provider)
        .send({
          lines: [
            {
              productId: product.id,
              quantity: 1,
              unitPriceCents: pending.totalCents,
            },
          ],
        }),
    )

    expectReconciliation(cancelled)
    expectReconciliation(reopened)
    expectReconciliation(removed)
    expectReconciliation(edited)
    const after = await moneyState(ctx, pending.orderId)
    expect(after.payments).toHaveLength(0)
    expect(after.order).toEqual({ status: 'pending_payment', paidAt: null })
    expect(after.stock).toEqual(pending.stock)
    expect(
      asRecord((await providerDetail(pending.orderId)).body).lines,
    ).toEqual(currentLines)
    expect(await loadAttempts(pending.orderId)).toEqual([pending.attempt])
  })

  it('retries the same revision and amount and records exactly one charge under the original reference', async () => {
    const ctx = context()
    const pending = await unreconciledCharge()
    delete ctx.payHooks.afterLedgerInsert

    const retry = result(
      await pay(
        ctx,
        pending.orderId,
        payBody(pending.revision, pending.totalCents),
      ),
    )

    expect(retry.status).toBe(200)
    expect(asRecord(retry.body).status).toBe('paid')
    const state = await moneyState(ctx, pending.orderId)
    expect(state.payments).toHaveLength(1)
    expect(state.ledger).toHaveLength(3)
    expect(state.stock).toEqual(pending.stock)
    expect(state.payments[0]?.amountCents).toBe(pending.totalCents)
    expect(state.payments[0]?.gatewayReference).toBe(
      pending.attempt.gatewayReference,
    )
    const linked = await loadPaymentLink(pending.orderId)
    expect(linked).toEqual({
      amountCents: pending.totalCents,
      gatewayReference: pending.attempt.gatewayReference,
      paymentAttemptId: pending.attempt.id,
    })
    const key = pending.attempt.idempotencyKey
    expect(ctx.gateway.charges.map((charge) => charge.idempotencyKey)).toEqual([
      key,
      key,
    ])
    expect(ctx.gateway.charges.map((charge) => charge.amountCents)).toEqual([
      pending.totalCents,
      pending.totalCents,
    ])
    expect(
      new Set(ctx.gateway.charges.map((charge) => charge.idempotencyKey)).size,
    ).toBe(1)
    const detail = await providerDetail(pending.orderId)
    const moved = asRecord(detail.body).lines
    if (!Array.isArray(moved)) {
      throw new Error('paid detail has no lines')
    }
    moved.forEach((line) => {
      const record = asRecord(line)
      const productId = numberValue(record.productId, 'productId')
      const quantity = numberValue(record.quantity, 'quantity')
      const seeded = ctx.seed.products.find(
        (product) => product.id === productId,
      )
      if (!seeded) {
        throw new Error(`product ${productId} was not seeded`)
      }
      expect(stockOf(state.stock, productId)).toBe(
        seeded.stockQuantity - quantity,
      )
    })
  })

  it('rejects the same idempotency key with a different amount and never succeeds', async () => {
    const gateway = new FakePaymentGateway()
    const key = 'order-9-r1'
    const request = {
      idempotencyKey: key,
      description: 'Supplement order 9',
    }
    const first: ChargeResult = await gateway.charge({
      ...request,
      amountCents: 2_000,
    })
    expect(first.status).toBe('succeeded')
    expect(first.reference.length).toBeGreaterThan(0)

    const replay = await gateway.charge({ ...request, amountCents: 2_000 })
    expect(replay).toEqual(first)

    const mismatch = await gateway.charge({ ...request, amountCents: 3_000 })
    expect(mismatch.status).toBe('failed')
    expect(mismatch.failureMessage).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(mismatch.status).not.toBe('succeeded')
  })

  it('maps IDEMPOTENCY_KEY_REUSED to 409 and does not record a payment', async () => {
    const ctx = context()
    const orderId = await createSentOrder(ctx)
    const detail = await providerDetail(orderId)
    const quote = quoteFrom(detail.body)
    expect(quote.expectedRevision).toBe(1)
    const { expectedRevision: revision, expectedTotalCents: totalCents } = quote
    const key = `order-${orderId}-r${revision}-e1`
    const seeded = await ctx.gateway.charge({
      amountCents: totalCents + 1,
      idempotencyKey: key,
      description: `Supplement order ${orderId}`,
    })
    expect(seeded.status).toBe('succeeded')
    const before = await moneyState(ctx, orderId)

    const rejected = result(
      await pay(ctx, orderId, payBody(revision, totalCents)),
    )

    expectApiError(rejected, 409, 'IDEMPOTENCY_KEY_REUSED')
    expect(rejected.status).not.toBe(200)
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toHaveLength(0)
    expect(after.ledger).toHaveLength(0)
    expect(after.order).toEqual(before.order)
    expect(after.stock).toEqual(before.stock)
    const again = await ctx.gateway.charge({
      amountCents: totalCents,
      idempotencyKey: key,
      description: `Supplement order ${orderId}`,
    })
    expect(again.status).toBe('failed')
    expect(again.failureMessage).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  describe('reversed product locks', () => {
    afterEach(async () => {
      await dropStockGate()
    })

    it('pays two orders with products A,B and B,A without a 40P01 deadlock', async () => {
      const ctx = context()
      const [first, second] = ctx.seed.products
      if (!first || !second) {
        throw new Error('seed needs two products')
      }
      await setStock(ctx, first.id, 10)
      await setStock(ctx, second.id, 10)
      const forward = pricedLines([first, second])
      const reverse = pricedLines([second, first])
      const orderAb = await createSentOrder(ctx, forward.lines)
      const orderBa = await createSentOrder(ctx, reverse.lines)
      const forwardQuote = quoteFrom((await providerDetail(orderAb)).body)
      const reverseQuote = quoteFrom((await providerDetail(orderBa)).body)
      expect(forwardQuote.expectedRevision).toBe(1)
      expect(reverseQuote.expectedRevision).toBe(1)
      expect(forwardQuote.expectedTotalCents).toBe(forward.totalCents)
      expect(reverseQuote.expectedTotalCents).toBe(reverse.totalCents)
      const before = await moneyState(ctx, orderAb)

      const client = new pg.Client({ connectionString: databaseUrl() })
      await client.connect()
      let results: HttpResult[] | undefined
      let pending: Promise<HttpResult[]> | undefined
      try {
        await installStockGate(client)
        await client.query('select pg_advisory_lock($1::bigint)', [STOCK_GATE])
        pending = Promise.all([
          pay(ctx, orderAb, forwardQuote).then(result),
          pay(ctx, orderBa, reverseQuote).then(result),
        ])
        await waitForStockOverlap(client, pending)
        await client.query('select pg_advisory_unlock($1::bigint)', [
          STOCK_GATE,
        ])
        results = await pending
      } finally {
        await client
          .query('select pg_advisory_unlock($1::bigint)', [STOCK_GATE])
          .catch(() => undefined)
        await client.end()
        if (pending && !results) {
          await pending.catch(() => undefined)
        }
      }
      if (!results) {
        throw new Error('the two payments did not finish')
      }

      expect(results.map((response) => response.status)).toEqual([200, 200])
      results.forEach((response) => {
        expect(JSON.stringify(response.body)).not.toContain('40P01')
        expect(asRecord(response.body).status).toBe('paid')
      })
      const ab = await moneyState(ctx, orderAb)
      const ba = await moneyState(ctx, orderBa)
      expect(ab.payments).toHaveLength(1)
      expect(ba.payments).toHaveLength(1)
      expect(stockOf(ab.stock, first.id)).toBe(
        stockOf(before.stock, first.id) - 2,
      )
      expect(stockOf(ab.stock, second.id)).toBe(
        stockOf(before.stock, second.id) - 2,
      )
    }, 20_000)
  })
})
