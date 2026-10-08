import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  orders,
  orderItems,
  payments,
  ledgerEntries,
  fakeGatewayCharges,
  paymentAttempts,
} from '../db/schema'
import { as, createSentOrder, moneyState, setStock } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// White-box assertions verify durable effects, including across process restart.
describe('revision 14 back-order payment integrity', () => {
  let ctx: InternalTestContext
  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx?.close()
  })

  async function fixture() {
    const [a, b, c] = ctx.seed.products
    const lines = [a!, b!, c!].map((product, index) => ({
      productId: product.id,
      quantity: [5, 2, 1][index]!,
      unitPriceCents: product.cogsCents + 1000,
    }))
    const id = await createSentOrder(ctx, lines)
    await setStock(ctx, a!.id, 2)
    await setStock(ctx, b!.id, 0)
    await setStock(ctx, c!.id, 10)
    const [order] = await ctx.db.select().from(orders).where(eq(orders.id, id))
    return {
      id,
      lines,
      body: {
        mode: 'available',
        expectedRevision: order!.revision,
        expectedTotalCents:
          2 * lines[0]!.unitPriceCents + lines[2]!.unitPriceCents,
        expectedPayableLines: [
          { productId: a!.id, quantity: 2 },
          { productId: c!.id, quantity: 1 },
        ],
      },
    }
  }
  function pay(id: number, body: object) {
    return ctx.request
      .post(`/api/orders/${id}/pay`)
      .set(as(ctx.seed.patientUserId))
      .send(body)
  }
  async function rows(id: number) {
    return ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(orderItems.productId)
  }
  async function children(id: number) {
    return (
      await ctx.db.execute(
        sql`select id, split_from_revision as revision from orders where split_from_order_id = ${id}`,
      )
    ).rows
  }
  async function assertBalanced(id: number) {
    const payment = await ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, id))
    const ledger = await ctx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, id))
    expect(payment).toHaveLength(1)
    expect(ledger).toHaveLength(3)
    expect(ledger.map((entry) => entry.type).sort()).toEqual([
      'cogs',
      'platform_fee',
      'provider_margin',
    ])
    expect(ledger.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(
      payment[0]!.amountCents,
    )
    ledger.forEach((entry) => expect(entry.paymentId).toBe(payment[0]!.id))
  }
  async function assertOneSplit(id: number, revision: number, child: number) {
    expect(await children(id)).toEqual([{ id: child, revision }])
    expect(await ctx.db.select().from(orders)).toHaveLength(2)
    expect(await ctx.db.select().from(payments)).toHaveLength(1)
    expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(1)
    await assertBalanced(id)
  }

  it('reduces the original, preserves back-order snapshots and links, and reserves only paid units', async () => {
    const f = await fixture()
    const original = await rows(f.id)
    const response = await pay(f.id, f.body)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      status: 'paid',
      revision: f.body.expectedRevision + 1,
      totalCents: f.body.expectedTotalCents,
      payment: { amountCents: f.body.expectedTotalCents },
      splitFromOrderId: null,
      backorderOrderId: expect.any(Number),
    })
    const child: number = response.body.backorderOrderId
    expect(await rows(f.id)).toMatchObject([
      { productId: f.lines[0]!.productId, quantity: 2 },
      { productId: f.lines[2]!.productId, quantity: 1 },
    ])
    expect(await rows(child)).toMatchObject(
      original.slice(0, 2).map((line, index) => ({
        productId: line.productId,
        quantity: [3, 2][index],
        unitPriceCents: line.unitPriceCents,
        unitCogsCents: line.unitCogsCents,
      })),
    )
    const [parent] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, f.id))
    const [backorder] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, child))
    expect(backorder).toMatchObject({
      status: 'pending_payment',
      revision: 1,
      patientId: parent!.patientId,
      providerId: parent!.providerId,
      totalCents:
        3 * f.lines[0]!.unitPriceCents + 2 * f.lines[1]!.unitPriceCents,
      sentAt: expect.any(Date),
    })
    const state = await moneyState(ctx, f.id)
    expect(
      state.stock
        .filter((p) => f.lines.some((line) => line.productId === p.id))
        .map((p) => p.stockQuantity),
    ).toEqual([0, 0, 9])
    const views = await Promise.allSettled(
      [ctx.seed.providerUserId, ctx.seed.patientUserId].map(async (user) => {
        const detail = await ctx.request
          .get(`/api/orders/${child}`)
          .set(as(user))
        expect(detail.status).toBe(200)
        expect(detail.body).toMatchObject({
          splitFromOrderId: f.id,
          backorderOrderId: null,
          blockedByOrderId: null,
        })
        const list = await ctx.request.get('/api/orders').set(as(user))
        expect(list.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: f.id, backorderOrderId: child }),
            expect.objectContaining({ id: child, splitFromOrderId: f.id }),
          ]),
        )
      }),
    )
    views.forEach((view) => {
      if (view.status === 'rejected') throw view.reason
    })
    await assertOneSplit(f.id, f.body.expectedRevision, child)
  })

  it.each(['stock', 'revision'])(
    'rejects a stale %s quote without splitting, reserving or charging',
    async (change) => {
      const f = await fixture()
      if (change === 'stock') await setStock(ctx, f.lines[0]!.productId, 1)
      const before = await moneyState(ctx, f.id)
      const original = await rows(f.id)
      const response = await pay(f.id, {
        ...f.body,
        expectedRevision:
          f.body.expectedRevision + (change === 'revision' ? 1 : 0),
      })
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('ORDER_CHANGED')
      expect(response.body.error.partialPaymentQuote.pay.totalCents).toBe(
        (change === 'stock' ? 1 : 2) * f.lines[0]!.unitPriceCents +
          f.lines[2]!.unitPriceCents,
      )
      expect(await moneyState(ctx, f.id)).toEqual(before)
      expect(await rows(f.id)).toEqual(original)
      expect(await ctx.db.select().from(orders)).toHaveLength(1)
      expect(await ctx.db.select().from(paymentAttempts)).toHaveLength(0)
      expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(0)
    },
  )

  it('replays the original quote before and after restart with one child and one charge', async () => {
    const f = await fixture()
    const first = await pay(f.id, f.body)
    expect(first.status).toBe(200)
    const before = await moneyState(ctx, f.id)
    const replay = await pay(f.id, f.body)
    expect(replay.status).toBe(200)
    ctx.restart()
    const restarted = await pay(f.id, f.body)
    expect(restarted.status).toBe(200)
    ;[replay, restarted].forEach((response) => {
      expect(response.body.payment).toEqual(first.body.payment)
      expect(response.body.backorderOrderId).toBe(first.body.backorderOrderId)
      expect(response.body.revision).toBe(first.body.revision)
    })
    expect(await moneyState(ctx, f.id)).toEqual(before)
    await assertOneSplit(
      f.id,
      f.body.expectedRevision,
      first.body.backorderOrderId,
    )
  })

  it('recovers a committed split and charge after failed finalization and restart', async () => {
    const f = await fixture()
    ctx.payHooks.afterLedgerInsert = async () => {
      throw new Error('injected finalization failure')
    }
    expect((await pay(f.id, f.body)).status).toBe(500)
    expect(await children(f.id)).toHaveLength(1)
    expect(await ctx.db.select().from(payments)).toHaveLength(0)
    expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(1)
    ctx.restart()
    const response = await pay(f.id, f.body)
    expect(response.status).toBe(200)
    await assertOneSplit(
      f.id,
      f.body.expectedRevision,
      response.body.backorderOrderId,
    )
  })

  it('keeps a declined split and retries the reduced order without another back-order', async () => {
    const f = await fixture()
    const declined = await pay(f.id, { ...f.body, simulateFailure: true })
    expect(declined.status).toBe(402)
    const childRows = await children(f.id)
    expect(childRows).toHaveLength(1)
    expect(await ctx.db.select().from(payments)).toHaveLength(0)
    const held = await moneyState(ctx, f.id)
    expect(
      held.stock
        .filter((p) => f.lines.some((line) => line.productId === p.id))
        .map((p) => p.stockQuantity),
    ).toEqual([2, 0, 10])
    ctx.restart()
    const retried = await pay(f.id, f.body)
    expect(retried.status).toBe(200)
    expect(retried.body.backorderOrderId).toBe(childRows[0]!.id)
    expect(await children(f.id)).toEqual(childRows)
    const charges = await ctx.db.select().from(fakeGatewayCharges)
    expect(
      charges.filter((charge) => charge.status === 'succeeded'),
    ).toHaveLength(1)
    expect(
      charges.filter((charge) => charge.status === 'declined'),
    ).toHaveLength(1)
    await assertBalanced(f.id)
  })

  it('serializes two concurrent available-pays into one split and one charge', async () => {
    const f = await fixture()
    const results = await Promise.all([pay(f.id, f.body), pay(f.id, f.body)])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(results[0]!.body.payment).toEqual(results[1]!.body.payment)
    expect(results[0]!.body.backorderOrderId).toBe(
      results[1]!.body.backorderOrderId,
    )
    await assertOneSplit(
      f.id,
      f.body.expectedRevision,
      results[0]!.body.backorderOrderId,
    )
  })

  it('chains another partial payment and balances the ledger on both paid orders', async () => {
    const f = await fixture()
    const first = await pay(f.id, f.body)
    expect(first.status).toBe(200)
    const child: number = first.body.backorderOrderId
    await setStock(ctx, f.lines[0]!.productId, 1)
    const second = await pay(child, {
      mode: 'available',
      expectedRevision: 1,
      expectedTotalCents: f.lines[0]!.unitPriceCents,
      expectedPayableLines: [{ productId: f.lines[0]!.productId, quantity: 1 }],
    })
    expect(second.status).toBe(200)
    const third: number = second.body.backorderOrderId
    expect(new Set([f.id, child, third]).size).toBe(3)
    expect(await children(f.id)).toEqual([
      { id: child, revision: f.body.expectedRevision },
    ])
    expect(await children(child)).toEqual([{ id: third, revision: 1 }])
    expect(await rows(third)).toMatchObject([
      {
        productId: f.lines[0]!.productId,
        quantity: 2,
        unitPriceCents: f.lines[0]!.unitPriceCents,
      },
      {
        productId: f.lines[1]!.productId,
        quantity: 2,
        unitPriceCents: f.lines[1]!.unitPriceCents,
      },
    ])
    await assertBalanced(f.id)
    await assertBalanced(child)
    expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(2)
  })

  it('blocks back-order reopen, permits cancel, and blocks reopen after cancel', async () => {
    const f = await fixture()
    const paid = await pay(f.id, f.body)
    expect(paid.status).toBe(200)
    const child: number = paid.body.backorderOrderId
    const before = await moneyState(ctx, child)
    const reopen = () =>
      ctx.request
        .post(`/api/orders/${child}/reopen`)
        .set(as(ctx.seed.providerUserId))
    const first = await reopen()
    expect(first.status).toBe(409)
    expect(first.body.error.code).toBe('BACKORDER_NOT_EDITABLE')
    const cancelled = await ctx.request
      .post(`/api/orders/${child}/cancel`)
      .set(as(ctx.seed.providerUserId))
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('cancelled')
    const again = await reopen()
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('BACKORDER_NOT_EDITABLE')
    const after = await moneyState(ctx, child)
    expect(after.stock).toEqual(before.stock)
    expect(after.payments).toEqual([])
    expect(after.ledger).toEqual([])
  })
})
