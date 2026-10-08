import { expectedPayableLinesOf } from '@supplement-orders/domain'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { paymentAttempts, products } from '../db/schema'
import { as, createDraft, createSentOrder, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 17.2: an order whose total is 0 can't be sent, and one that
// already exists can't be paid, before anything is held or charged.
describe('revision 17.2: no orders with a zero total', () => {
  let ctx: InternalTestContext

  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx.close()
  })

  async function freeProduct(stockQuantity = 10) {
    const [product] = await ctx.db
      .insert(products)
      .values({
        sku: `FREE-${stockQuantity}`,
        name: `Free sample ${stockQuantity}`,
        cogsCents: 0,
        stockQuantity,
      })
      .returning({ id: products.id })
    return product!.id
  }

  async function stockOf(productId: number) {
    const [row] = await ctx.db
      .select({ stock: products.stockQuantity })
      .from(products)
      .where(eq(products.id, productId))
    return row!.stock
  }

  async function chargeCount() {
    const result = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from fake_gateway_charges`,
    )
    return result.rows[0]!.n
  }

  /** A sent order with only $0 lines, as an order from before 17.2 could be. */
  async function legacyZeroOrder(productId: number) {
    const orderId = await createDraft(ctx, [
      { productId, quantity: 2, unitPriceCents: 0 },
    ])
    await ctx.db.execute(sql`
      update orders set status = 'pending_payment', sent_at = now(), revision = 1,
        subtotal_cents = 0, platform_fee_cents = 0, total_cents = 0
      where id = ${orderId}`)
    await ctx.db.execute(sql`
      update order_items set unit_cogs_cents = 0, product_name = 'Free sample',
        product_sku = 'FREE' where order_id = ${orderId}`)
    return orderId
  }

  it('keeps a $0 line in a draft but refuses to send an order with only $0 lines', async () => {
    const productId = await freeProduct()
    const orderId = await createDraft(ctx, [
      { productId, quantity: 1, unitPriceCents: 0 },
    ])

    const sent = await ctx.request
      .post(`/api/orders/${orderId}/send`)
      .set(as(ctx.seed.providerUserId))

    expect(sent.status).toBe(400)
    expect(sent.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'lines',
      message: 'Order total must be greater than $0.00',
    })
    const detail = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.providerUserId))
    expect(detail.body.status).toBe('draft')
  })

  it('sends an order with a $0 line when its total is above zero', async () => {
    const productId = await freeProduct()
    const [paid] = ctx.seed.products

    const orderId = await createSentOrder(ctx, [
      { productId, quantity: 1, unitPriceCents: 0 },
      {
        productId: paid!.id,
        quantity: 1,
        unitPriceCents: paid!.cogsCents + 500,
      },
    ])

    expect((await pay(ctx, orderId)).status).toBe(200)
  })

  it('refuses to pay a legacy zero-total order, holding and charging nothing', async () => {
    const productId = await freeProduct()
    const orderId = await legacyZeroOrder(productId)

    const res = await pay(ctx, orderId)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ORDER_CHANGED')
    expect(
      await ctx.db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, orderId)),
    ).toEqual([])
    expect(await stockOf(productId)).toBe(10)
    expect(await chargeCount()).toBe(0)
  })

  it('refuses an available-mode pay whose in-stock lines total 0, before splitting', async () => {
    const free = await freeProduct()
    const [paid] = ctx.seed.products
    const orderId = await createSentOrder(ctx, [
      { productId: free, quantity: 1, unitPriceCents: 0 },
      {
        productId: paid!.id,
        quantity: 1,
        unitPriceCents: paid!.cogsCents + 500,
      },
    ])
    await ctx.db
      .update(products)
      .set({ stockQuantity: 0 })
      .where(eq(products.id, paid!.id))
    const detail = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.patientUserId))
    expect(detail.body.partialPaymentQuote.pay.totalCents).toBe(0)

    const res = await ctx.request
      .post(`/api/orders/${orderId}/pay`)
      .set(as(ctx.seed.patientUserId))
      .send({
        expectedRevision: detail.body.revision,
        expectedTotalCents: 0,
        mode: 'available',
        expectedPayableLines: expectedPayableLinesOf(detail.body.lines),
      })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ORDER_CHANGED')
    const after = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.patientUserId))
    expect(after.body.revision).toBe(detail.body.revision)
    expect(after.body.backorder ?? null).toBeNull()
    expect(await stockOf(free)).toBe(10)
    expect(await chargeCount()).toBe(0)
  })
})
