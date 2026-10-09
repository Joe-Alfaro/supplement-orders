import { sql } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { as, createSentOrder, moneyState, pay } from '../testing/flows'
import {
  attemptKey,
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 19.1 (notes/DOMAIN_CONTRACT.md): no second charge after abandonment.
// Seams: vi.spyOn(ctx.gateway, 'charge') to hold the first gateway call just
// before the fake's durable insert, ctx.clock for the 15-minute window, and
// direct SQL for durable state. Assumption (the contract names no route): the
// admin "mark refunded" action is POST /api/admin/payment-attempts/:id/refund.
describe('revision 19.1 abandonment never leads to a second charge', () => {
  let ctx: InternalTestContext
  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx?.close()
  })

  const provider = () => as(ctx.seed.providerUserId)
  const admin = () => as(ctx.seed.adminUserId)

  function sentOrder() {
    return createSentOrder(ctx, [
      {
        productId: ctx.seed.products[0]!.id,
        quantity: 2,
        unitPriceCents: 5000,
      },
    ])
  }
  function reconcile(attemptId: number) {
    return ctx.request
      .post(`/api/admin/payment-attempts/${attemptId}/reconcile`)
      .set(admin())
  }
  function unresolved() {
    return ctx.request
      .get('/api/admin/payment-attempts')
      .query({ status: 'unresolved' })
      .set(admin())
  }
  function providerAction(id: number, name: 'cancel' | 'reopen' | 'send') {
    return ctx.request.post(`/api/orders/${id}/${name}`).set(provider())
  }
  async function attemptsOf(orderId: number) {
    return (
      await ctx.db.execute<{
        id: number
        revision: number
        execution: number
        status: string
        stock_held: boolean
        idempotency_key: string
        gateway_reference: string | null
        created_at: string
      }>(sql`select id, revision, execution, status, stock_held, idempotency_key,
        gateway_reference, created_at from payment_attempts
        where order_id = ${orderId} order by id`)
    ).rows
  }
  async function gatewayState() {
    const row = (
      await ctx.db.execute<{ succeeded: string; keys: string }>(sql`
        select count(*) filter (where status = 'succeeded') as succeeded,
          count(distinct idempotency_key) as keys
        from fake_gateway_charges`)
    ).rows[0]!
    return { succeeded: Number(row.succeeded), keys: Number(row.keys) }
  }
  async function stockOf(productId: number) {
    const row = (
      await ctx.db.execute<{ stock_quantity: number }>(
        sql`select stock_quantity from products where id = ${productId}`,
      )
    ).rows[0]!
    return Number(row.stock_quantity)
  }

  /** Holds the first gateway call until release(); later calls pass straight through. */
  function holdFirstCharge() {
    const original = ctx.gateway.charge.bind(ctx.gateway)
    let release!: () => void
    let entered!: () => void
    const latch = new Promise<void>((resolve) => (release = resolve))
    const ready = new Promise<void>((resolve) => (entered = resolve))
    let first = true
    vi.spyOn(ctx.gateway, 'charge').mockImplementation(async (req, opts) => {
      if (first) {
        first = false
        entered()
        await latch
      }
      return original(req, opts)
    })
    return { ready, release }
  }
  /** The auditor's setup: original pay in flight, 16 minutes pass, admin abandons it. */
  async function inFlightThenAbandoned(orderId: number) {
    const held = holdFirstCharge()
    const original = pay(ctx, orderId)
    await held.ready
    const [attempt] = await attemptsOf(orderId)
    ctx.clock!.now = new Date(
      new Date(attempt!.created_at).getTime() + 16 * 60_000,
    )
    const abandon = await reconcile(attempt!.id)
    expect(abandon.status).toBe(200)
    expect(abandon.body.outcome).toBe('abandoned')
    return { attempt: attempt!, original, release: held.release }
  }

  it("19.1 the auditor's interleaving: held call, +16 min, abandon, retry, release gives one charge, one payment and no 409", async () => {
    const id = await sentOrder()
    const { attempt, original, release } = await inFlightThenAbandoned(id)

    const retry = await pay(ctx, id)
    expect(retry.status).toBe(200)
    release()
    const late = await original
    expect(late.status).not.toBe(409)
    expect(late.status).toBeLessThan(500)

    expect(await gatewayState()).toEqual({ succeeded: 1, keys: 1 })
    const state = await moneyState(ctx, id)
    expect(state.order?.status).toBe('paid')
    expect(state.payments).toHaveLength(1)
    expect(state.journals).toHaveLength(1)
    expect(state.payments[0]!.idempotencyKey).toBe(attempt.idempotency_key)
    // Whoever replays the reconcile afterwards changes nothing.
    expect((await reconcile(attempt.id)).status).toBeLessThan(500)
    expect(await gatewayState()).toEqual({ succeeded: 1, keys: 1 })
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)
    expect(await unresolved().then((r) => r.body)).toEqual([])
  })

  it('19.1 abandoning retires no key: the retry reuses the abandoned execution key and takes the stock again', async () => {
    const id = await sentOrder()
    const productId = ctx.seed.products[0]!.id
    const stockBefore = await stockOf(productId)
    vi.spyOn(ctx.gateway, 'charge').mockRejectedValueOnce(
      new Error('ECONNRESET'),
    )
    expect((await pay(ctx, id)).status).toBe(503)
    const [attempt] = await attemptsOf(id)
    ctx.clock!.now = new Date(
      new Date(attempt!.created_at).getTime() + 16 * 60_000,
    )
    expect((await reconcile(attempt!.id)).status).toBe(200)
    expect(await stockOf(productId)).toBe(stockBefore)

    expect((await pay(ctx, id)).status).toBe(200)
    const key = attemptKey(ctx, id, attempt!.revision, 1)
    expect(attempt!.idempotency_key).toBe(key)
    expect(ctx.gateway.charges.map((c) => c.idempotencyKey)).toEqual([key])
    expect((await attemptsOf(id)).filter((a) => a.execution > 1)).toEqual([])
    expect(await stockOf(productId)).toBe(stockBefore - 2)
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)
  })

  it('19.1 a definitive decline still starts a new key', async () => {
    const id = await sentOrder()
    expect((await pay(ctx, id, { simulateFailure: true })).status).toBe(402)
    expect((await pay(ctx, id)).status).toBe(200)
    expect((await attemptsOf(id)).map((a) => a.idempotency_key)).toEqual([
      attemptKey(ctx, id, 1, 1),
      attemptKey(ctx, id, 1, 2),
    ])
  })

  it('19.1 a late success on an abandoned attempt is recorded as late_success with amount and reference, and listed as unresolved', async () => {
    const id = await sentOrder()
    const { attempt, original, release } = await inFlightThenAbandoned(id)
    release()
    await original
    const [row] = await attemptsOf(id)
    expect(row).toMatchObject({ id: attempt.id, status: 'late_success' })
    expect(row!.gateway_reference).toMatch(/^fake_ch_/)

    const list = await unresolved()
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({
      id: attempt.id,
      orderId: id,
      status: 'late_success',
      amountCents: 10000,
    })
    expect(JSON.stringify(list.body)).toContain(row!.gateway_reference!)
  })

  it('19.1 reconciling a late_success on a still-unpaid order finalizes it with that charge', async () => {
    const id = await sentOrder()
    const { attempt, original, release } = await inFlightThenAbandoned(id)
    release()
    await original
    expect((await attemptsOf(id))[0]!.status).toBe('late_success')
    expect((await reconcile(attempt.id)).status).toBe(200)
    const state = await moneyState(ctx, id)
    expect(state.order?.status).toBe('paid')
    expect(state.payments).toHaveLength(1)
    expect(state.payments[0]!.amountCents).toBe(10000)
    expect(await gatewayState()).toEqual({ succeeded: 1, keys: 1 })
    expect((await unresolved()).body).toEqual([])
    expect((await reconcile(attempt.id)).status).toBeLessThan(500)
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)
  })

  /**
   * Abandon the in-flight attempt, change the order (cancel, reopen, resend:
   * revision 2) and pay it with a new execution while the original call is
   * still unseen by the gateway: the lookup finds nothing, so a new key is fine.
   */
  async function paidAnotherWayThenLateSuccess() {
    const id = await sentOrder()
    const { attempt, original, release } = await inFlightThenAbandoned(id)
    expect((await providerAction(id, 'cancel')).status).toBe(200)
    expect((await providerAction(id, 'reopen')).status).toBe(200)
    expect((await providerAction(id, 'send')).status).toBe(200)
    expect((await pay(ctx, id)).status).toBe(200)
    release()
    await original
    return { id, attempt }
  }

  it('19.1 cancel and reopen after an abandonment: the lookup finds nothing, so the new revision gets its own key', async () => {
    const { id, attempt } = await paidAnotherWayThenLateSuccess()
    const rows = await attemptsOf(id)
    const paidRow = rows.find((a) => a.id !== attempt.id)!
    expect(paidRow.revision).toBeGreaterThan(attempt.revision)
    expect(paidRow.idempotency_key).toBe(
      attemptKey(ctx, id, paidRow.revision, 1),
    )
    expect(paidRow.idempotency_key).not.toBe(attempt.idempotency_key)
  })

  it('19.1 a late success after the order was paid another way is listed as refund_required with its amount and reference', async () => {
    const { id, attempt } = await paidAnotherWayThenLateSuccess()
    // The gateway really did charge twice; the app must not hide it.
    expect(await gatewayState()).toEqual({ succeeded: 2, keys: 2 })
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)

    const before = await unresolved()
    expect(before.body.map((i: { id: number }) => i.id)).toContain(attempt.id)
    const reconciled = await reconcile(attempt.id)
    expect(reconciled.status).toBe(200)

    const [late] = (await attemptsOf(id)).filter((a) => a.id === attempt.id)
    expect(late).toMatchObject({ status: 'refund_required' })
    const list = await unresolved()
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({
      id: attempt.id,
      orderId: id,
      status: 'refund_required',
      amountCents: 10000,
    })
    expect(JSON.stringify(list.body)).toContain(late!.gateway_reference!)
    // Still one payment: the extra charge never becomes revenue.
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)
    expect((await moneyState(ctx, id)).journals).toHaveLength(1)
  })

  it('19.1 marking a refund_required attempt refunded calls gateway.refund(key) once and clears it from the unresolved list', async () => {
    const { id, attempt } = await paidAnotherWayThenLateSuccess()
    expect((await reconcile(attempt.id)).status).toBe(200)
    const gateway = ctx.gateway as unknown as {
      refund: (key: string) => Promise<unknown>
    }
    expect(typeof gateway.refund).toBe('function')
    const refund = vi.spyOn(gateway, 'refund')

    const response = await ctx.request
      .post(`/api/admin/payment-attempts/${attempt.id}/refund`)
      .set(admin())
    expect(response.status).toBe(200)
    expect(refund).toHaveBeenCalledTimes(1)
    expect(refund).toHaveBeenCalledWith(attempt.idempotency_key)
    expect((await unresolved()).body).toEqual([])
    // Idempotent: no second refund is issued.
    const again = await ctx.request
      .post(`/api/admin/payment-attempts/${attempt.id}/refund`)
      .set(admin())
    expect(again.status).toBeLessThan(500)
    expect(refund).toHaveBeenCalledTimes(1)
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)
  })

  it('19.1 only an admin can mark a refund', async () => {
    const { attempt } = await paidAnotherWayThenLateSuccess()
    expect((await reconcile(attempt.id)).status).toBe(200)
    const asPatient = await ctx.request
      .post(`/api/admin/payment-attempts/${attempt.id}/refund`)
      .set(as(ctx.seed.patientUserId))
    const asProvider = await ctx.request
      .post(`/api/admin/payment-attempts/${attempt.id}/refund`)
      .set(provider())
    expect(asPatient.status).toBe(403)
    expect(asProvider.status).toBe(403)
  })

  it('19.1 cancel and reopen after an abandonment issue no new key while the abandoned charge may exist: once the lookup finds a success, the order is blocked', async () => {
    const id = await sentOrder()
    const { attempt, original, release } = await inFlightThenAbandoned(id)
    expect((await providerAction(id, 'cancel')).status).toBe(200)
    expect((await providerAction(id, 'reopen')).status).toBe(200)
    expect((await providerAction(id, 'send')).status).toBe(200)
    // The abandoned call lands at the processor after all.
    release()
    await original
    expect(await gatewayState()).toEqual({ succeeded: 1, keys: 1 })

    const callsBefore = ctx.gateway.charges.length
    const blocked = await pay(ctx, id)
    expect(blocked.status).not.toBe(200)
    expect(blocked.status).toBeLessThan(500)
    // No new key reached the processor, and nothing was charged or recorded.
    expect(
      ctx.gateway.charges
        .slice(callsBefore)
        .filter((c) => c.idempotencyKey !== attempt.idempotency_key),
    ).toEqual([])
    expect(await gatewayState()).toEqual({ succeeded: 1, keys: 1 })
    expect((await moneyState(ctx, id)).payments).toHaveLength(0)
    expect((await attemptsOf(id)).filter((a) => a.id !== attempt.id)).toEqual(
      [],
    )
    // The stranded charge is visible to the admin.
    expect(
      (await unresolved()).body.map((i: { id: number }) => i.id),
    ).toContain(attempt.id)
  })
})
