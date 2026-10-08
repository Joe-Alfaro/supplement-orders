import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  orders,
  orderItems,
  paymentAttempts,
  fakeGatewayCharges,
} from '../db/schema'
import {
  as,
  createSentOrder,
  moneyState,
  pay,
  setStock,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

describe('revision 15 audit payment and chain contracts', () => {
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
  function detail(id: number, user = ctx.seed.patientUserId) {
    return ctx.request.get(`/api/orders/${id}`).set(as(user))
  }
  function action(id: number, name: string) {
    return ctx.request
      .post(`/api/orders/${id}/${name}`)
      .set(as(ctx.seed.providerUserId))
  }
  async function single() {
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 1, unitPriceCents: 5000 },
    ])
    return { id, product }
  }
  // Historical revision-14 chains can have unpaid ancestors. Seed links only;
  // all orders, lines and snapshots are otherwise created through the API.
  async function chain() {
    const ids = [await single(), await single(), await single()].map(
      ({ id }) => id,
    )
    await ctx.db.execute(
      sql`update orders set split_from_order_id = ${ids[0]}, split_from_revision = 1 where id = ${ids[1]}`,
    )
    await ctx.db.execute(
      sql`update orders set split_from_order_id = ${ids[1]}, split_from_revision = 1 where id = ${ids[2]}`,
    )
    return ids as [number, number, number]
  }
  it('H1 last-unit recovery retains pending_payment and payable quote after restart, completing without a new charge', async () => {
    const { id, product } = await single()
    await setStock(ctx, product.id, 1)
    const before = await detail(id)
    ctx.payHooks.afterLedgerInsert = async () => {
      throw new Error('finalization unavailable')
    }
    expect((await pay(ctx, id)).status).toBe(500)
    expect(await ctx.db.select().from(fakeGatewayCharges)).toMatchObject([
      { status: 'succeeded', amountCents: 5000 },
    ])
    expect(
      (await moneyState(ctx, id)).stock.find((p) => p.id === product.id)
        ?.stockQuantity,
    ).toBe(0)
    ctx.restart()
    const recovering = await detail(id)
    expect(recovering.status).toBe(200)
    expect.soft(recovering.body.status).toBe('pending_payment')
    expect.soft(recovering.body.lines[0].payableQuantity).toBe(1)
    expect.soft(recovering.body.partialPaymentQuote.pay.totalCents).toBe(5000)
    const completed = await pay(ctx, id, {
      expectedRevision: before.body.revision,
      expectedTotalCents: 5000,
    })
    expect(completed.status).toBe(200)
    expect(completed.body.status).toBe('paid')
    expect(ctx.gateway.charges).toHaveLength(0)
    expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(1)
    expect((await moneyState(ctx, id)).payments).toHaveLength(1)
  })
  it.each([
    ['product swap', [1, 0], [0, 1]],
    ['quantity redistribution', [2, 1], [1, 2]],
  ] as const)(
    'M2 rejects equal-total %s without split, reservation or charge',
    async (_name, initial, changed) => {
      const lines = ctx.seed.products
        .slice(0, 2)
        .map((p) => ({ productId: p.id, quantity: 3, unitPriceCents: 5000 }))
      const id = await createSentOrder(ctx, lines)
      await Promise.all(
        lines.map((line, i) => setStock(ctx, line.productId, initial[i]!)),
      )
      const quote = await detail(id)
      const expectedPayableLines = lines.flatMap((line, i) =>
        initial[i] ? [{ productId: line.productId, quantity: initial[i] }] : [],
      )
      await Promise.all(
        lines.map((line, i) => setStock(ctx, line.productId, changed[i]!)),
      )
      const before = await moneyState(ctx, id)
      const originalLines = await ctx.db.select().from(orderItems)
      const response = await pay(ctx, id, {
        mode: 'available',
        expectedRevision: quote.body.revision,
        expectedTotalCents: quote.body.partialPaymentQuote.pay.totalCents,
        expectedPayableLines,
      })
      expect.soft(response.status).toBe(409)
      expect.soft(response.body.error?.code).toBe('ORDER_CHANGED')
      expect
        .soft(response.body.error?.partialPaymentQuote?.pay.totalCents)
        .toBe(quote.body.partialPaymentQuote.pay.totalCents)
      expect.soft(await moneyState(ctx, id)).toEqual(before)
      expect.soft(await ctx.db.select().from(orderItems)).toEqual(originalLines)
      expect.soft(await ctx.db.select().from(orders)).toHaveLength(1)
      expect.soft(await ctx.db.select().from(paymentAttempts)).toHaveLength(0)
      expect(ctx.gateway.charges).toHaveLength(0)
    },
  )
  it('M2 accepts matching payable lines in a different order with zero quantities omitted', async () => {
    const lines = ctx.seed.products
      .slice(0, 3)
      .map((p) => ({ productId: p.id, quantity: 3, unitPriceCents: 5000 }))
    const id = await createSentOrder(ctx, lines)
    await Promise.all(
      lines.map((line, i) => setStock(ctx, line.productId, [1, 2, 0][i]!)),
    )
    const response = await pay(ctx, id, {
      mode: 'available',
      expectedTotalCents: 15000,
      expectedPayableLines: [
        { productId: lines[1]!.productId, quantity: 2 },
        { productId: lines[0]!.productId, quantity: 1 },
      ],
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      status: 'paid',
      totalCents: 15000,
      backorderOrderId: expect.any(Number),
    })
    expect(ctx.gateway.charges).toHaveLength(1)
    expect(ctx.gateway.charges[0]!.amountCents).toBe(15000)
  })
  it('M3 cancelling the original cancels every downstream back-order', async () => {
    const ids = await chain()
    expect((await action(ids[0], 'cancel')).status).toBe(200)
    expect((await ctx.db.select().from(orders)).map((o) => o.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ])
  })
  it.each([0, 1, 2])(
    'M3 unresolved attempt at chain position %i blocks the whole cancellation atomically',
    async (position) => {
      const ids = await chain()
      const id = ids[position]!
      // An unresolved historical attempt is valid even on a descendant whose
      // parent is unpaid; new pay requests must no longer create that state.
      const [order] = await ctx.db
        .select()
        .from(orders)
        .where(eq(orders.id, id))
      await ctx.db.insert(paymentAttempts).values({
        orderId: id,
        revision: order!.revision,
        execution: 1,
        idempotencyKey: `chain-${id}`,
        amountCents: 5000,
        status: 'pending',
        stockHeld: true,
      })
      const before = await ctx.db.select().from(orders)
      expect.soft((await action(ids[0], 'cancel')).status).toBe(409)
      expect(await ctx.db.select().from(orders)).toEqual(before)
    },
  )
  it('M3 cancel then reopen then delete removes the original and all descendants without 500', async () => {
    const [id] = await chain()
    expect((await action(id, 'cancel')).status).toBe(200)
    expect((await action(id, 'reopen')).status).toBe(200)
    const downstream = (await ctx.db.select().from(orders)).filter(
      (o) => o.id !== id,
    )
    expect
      .soft(downstream.map((o) => o.status))
      .toEqual(['cancelled', 'cancelled'])
    const deleted = await ctx.request
      .delete(`/api/orders/${id}`)
      .set(as(ctx.seed.providerUserId))
    expect.soft(deleted.status).toBe(204)
    expect.soft(await ctx.db.select().from(orders)).toEqual([])
    expect(await ctx.db.select().from(orderItems)).toEqual([])
  })
  it('M3 fully stocked back-order rejects payment until its parent pays, then succeeds', async () => {
    const [parent, child] = await chain()
    const before = await moneyState(ctx, child)
    const blocked = await pay(ctx, child)
    expect.soft(blocked.status).toBe(409)
    expect
      .soft(blocked.body.error)
      .toMatchObject({ code: 'PRIOR_ORDER_UNPAID', priorOrderId: parent })
    expect.soft(await moneyState(ctx, child)).toEqual(before)
    expect.soft(ctx.gateway.charges).toHaveLength(0)
    expect((await pay(ctx, parent)).status).toBe(200)
    expect((await pay(ctx, child)).status).toBe(200)
  })
  it('M3 provider and patient detail/list DTOs identify the unpaid direct parent and clear it after payment', async () => {
    const [parent, child, grandchild] = await chain()
    async function check(expected: number | null) {
      await Promise.all(
        [ctx.seed.patientUserId, ctx.seed.providerUserId].map(async (user) => {
          expect
            .soft((await detail(child, user)).body.blockedByOrderId)
            .toBe(expected)
          expect
            .soft((await detail(parent, user)).body.blockedByOrderId)
            .toBeNull()
          expect
            .soft((await detail(grandchild, user)).body.blockedByOrderId)
            .toBe(child)
          const list = await ctx.request.get('/api/orders').set(as(user))
          const rows: { id: number; blockedByOrderId: number | null }[] =
            Array.isArray(list.body) ? list.body : list.body.items
          expect
            .soft(rows.find((row) => row.id === child)?.blockedByOrderId)
            .toBe(expected)
        }),
      )
    }
    await check(parent)
    expect((await pay(ctx, parent)).status).toBe(200)
    await check(null)
  })
  it('M4 hold, set maximum, decline, then correct 1000001 to 10 returns 200', async () => {
    const { id, product } = await single()
    await setStock(ctx, product.id, 1)
    const original = ctx.gateway.charge.bind(ctx.gateway)
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    ctx.gateway.charge = async (request, options) => {
      reached()
      await gate
      return original(request, options)
    }
    const paying = pay(ctx, id, { simulateFailure: true })
    function stock(value: number, expected: number) {
      return ctx.request
        .put(`/api/admin/products/${product.id}/stock`)
        .set(as(ctx.seed.adminUserId))
        .send({ stockQuantity: value, expectedStockQuantity: expected })
    }
    try {
      await started
      expect((await stock(1000000, 0)).status).toBe(200)
    } finally {
      release()
      await paying
      Reflect.deleteProperty(ctx.gateway, 'charge')
    }
    expect((await paying).status).toBe(402)
    expect(
      (await moneyState(ctx, id)).stock.find((p) => p.id === product.id)
        ?.stockQuantity,
    ).toBe(1000001)
    const corrected = await stock(10, 1000001)
    expect(corrected.status).toBe(200)
    expect(corrected.body.stockQuantity).toBe(10)
  })
})
