import { USER_ID_HEADER, type OrderLineInput } from '@supplement-orders/domain'
import { eq } from 'drizzle-orm'
import { expect } from 'vitest'
import { ledgerEntries, orders, payments, products } from '../db/schema'
import type { InternalTestContext, TestContext } from './harness'

export function as(userId: number) {
  return { [USER_ID_HEADER]: String(userId) }
}

/** Two lines priced above COGS, from the first two seeded products. */
export function sampleLines(ctx: TestContext): OrderLineInput[] {
  const [a, b] = ctx.seed.products
  return [
    { productId: a!.id, quantity: 2, unitPriceCents: a!.cogsCents + 1000 },
    { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents + 333 },
  ]
}

export async function createDraft(
  ctx: TestContext,
  lines: OrderLineInput[] = sampleLines(ctx),
) {
  const created = await ctx.request
    .post('/api/orders')
    .set(as(ctx.seed.providerUserId))
    .send({ patientId: ctx.seed.patientId })
  expect(created.status).toBe(201)
  const orderId: number = created.body.id
  const put = await ctx.request
    .put(`/api/orders/${orderId}/lines`)
    .set(as(ctx.seed.providerUserId))
    .send({ lines })
  expect(put.status).toBe(200)
  return orderId
}

export async function createSentOrder(
  ctx: TestContext,
  lines: OrderLineInput[] = sampleLines(ctx),
) {
  const orderId = await createDraft(ctx, lines)
  const sent = await ctx.request
    .post(`/api/orders/${orderId}/send`)
    .set(as(ctx.seed.providerUserId))
  expect(sent.status).toBe(200)
  return orderId
}

export function pay(ctx: TestContext, orderId: number, body: object = {}) {
  return ctx.request
    .post(`/api/orders/${orderId}/pay`)
    .set(as(ctx.seed.patientUserId))
    .send(body)
}

/** Everything the pay transaction may touch, read straight from the database. */
export async function moneyState(ctx: InternalTestContext, orderId: number) {
  const [order] = await ctx.db
    .select({ status: orders.status, paidAt: orders.paidAt })
    .from(orders)
    .where(eq(orders.id, orderId))
  return {
    order,
    payments: await ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId)),
    ledger: await ctx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId)),
    stock: await ctx.db
      .select({ id: products.id, stockQuantity: products.stockQuantity })
      .from(products)
      .orderBy(products.id),
  }
}
