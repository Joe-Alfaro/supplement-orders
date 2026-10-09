import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  as,
  createSentOrder,
  insertPaymentJournal,
  insertSucceededAttempt,
  journalSplitOf,
  moneyState,
  pay,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { products } from './schema'

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  return typeof code === 'string' ? code : sqlState(cause)
}
async function integrityViolation(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(
    sqlState(error) ?? 'NO_SQLSTATE',
    'paid records must reject mutations with SQLSTATE class 23',
  ).toMatch(/^23/)
}

describe('revision 15 frozen paid records', () => {
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
  async function paid() {
    const id = await createSentOrder(ctx)
    expect((await pay(ctx, id)).status).toBe(200)
    return id
  }
  function detail(id: number) {
    return ctx.request.get(`/api/orders/${id}`).set(as(ctx.seed.providerUserId))
  }
  it.each(['revision', 'total_cents', 'status', 'sent_at'] as const)(
    'L1 rejects direct SQL UPDATE of paid order %s',
    async (column) => {
      const id = await paid()
      const changes = {
        revision: sql`revision + 1`,
        total_cents: sql`total_cents + 1`,
        status: sql`'pending_payment'`,
        sent_at: sql`sent_at + interval '1 second'`,
      }
      await integrityViolation(
        ctx.db.execute(
          sql`update orders set ${sql.identifier(column)} = ${changes[column]} where id = ${id}`,
        ),
      )
    },
  )
  it('L1 allows updated_at-only changes to a paid order', async () => {
    const id = await paid()
    await ctx.db.execute(
      sql`update orders set updated_at = updated_at + interval '1 second' where id = ${id}`,
    )
    expect((await detail(id)).body.status).toBe('paid')
  })
  it('L1 rejects direct SQL DELETE of a paid order', async () => {
    const id = await paid()
    await integrityViolation(
      ctx.db.execute(sql`delete from orders where id = ${id}`),
    )
    expect((await detail(id)).status).toBe(200)
  })
  it.each(['insert', 'update', 'delete'] as const)(
    'L1 rejects direct SQL %s of paid order items',
    async (operation) => {
      const id = await paid()
      const before = (await detail(id)).body.lines
      // jsonb_populate_record copies all columns, including snapshots added by
      // revision 15, while using a fresh identity and unused product. Thus an
      // unrelated NOT NULL or duplicate-product constraint cannot mask the guard.
      const statements = {
        insert: sql`insert into order_items select (jsonb_populate_record(null::order_items, to_jsonb(i) || jsonb_build_object('id', 999999, 'product_id', ${ctx.seed.products[2]!.id}::integer))).* from order_items i where order_id = ${id} limit 1`,
        update: sql`update order_items set quantity = quantity + 1 where order_id = ${id}`,
        delete: sql`delete from order_items where order_id = ${id}`,
      }
      await integrityViolation(ctx.db.execute(statements[operation]))
      expect((await detail(id)).body.lines).toEqual(before)
    },
  )
  it('L1 product rename leaves the paid line name unchanged for provider and patient', async () => {
    const id = await paid()
    const before = await detail(id)
    const line = before.body.lines[0]
    await ctx.db
      .update(products)
      .set({ name: 'Renamed after payment', sku: 'RENAMED-PAID' })
      .where(eq(products.id, line.productId))
    await Promise.all(
      [ctx.seed.providerUserId, ctx.seed.patientUserId].map(async (user) => {
        const response = await ctx.request
          .get(`/api/orders/${id}`)
          .set(as(user))
        expect(response.status).toBe(200)
        expect(
          response.body.lines.find(
            (item: { productId: number }) => item.productId === line.productId,
          ).productName,
        ).toBe(line.productName)
      }),
    )
  })
  it('L1 paid split equals the immutable journal, including legacy fee rounding', async () => {
    const id = await createSentOrder(ctx)
    // Construct a balanced historical payment with a different fee from the
    // current formula, stored on the order BEFORE paid freezes it. This
    // distinguishes a journal read from recomputation without disabling any
    // production integrity trigger. (Revision 17.3: the journal's cost must
    // match the order's line snapshots, so only the fee differs.)
    const before = await detail(id)
    const total: number = before.body.split.totalCents
    const cogs: number = before.body.split.cogsCents
    const fee: number = before.body.split.platformFeeCents - 1
    await ctx.db.transaction(async (tx) => {
      const paymentAttemptId = await insertSucceededAttempt(tx, {
        orderId: id,
        amountCents: total,
        key: `legacy-${id}`,
      })
      const payment = await tx.execute<{ id: number }>(
        sql`insert into payments (order_id, amount_cents, idempotency_key, gateway_reference, payment_attempt_id) values (${id}, ${total}, ${`legacy-${id}`}, ${`ref-legacy-${id}`}, ${paymentAttemptId}) returning id`,
      )
      const paymentId = payment.rows[0]!.id
      await insertPaymentJournal(tx, {
        paymentId,
        orderId: id,
        cogsCents: cogs,
        marginCents: total - cogs - fee,
        feeCents: fee,
      })
      await tx.execute(
        sql`update orders set status = 'paid', paid_at = now(), platform_fee_cents = ${fee} where id = ${id}`,
      )
    })
    const recorded = journalSplitOf((await moneyState(ctx, id)).postings)
    expect(recorded).toEqual({
      totalCents: total,
      cogsCents: cogs,
      platformFeeCents: fee,
      providerMarginCents: total - cogs - fee,
    })
    expect((await detail(id)).body.split).toEqual({
      subtotalCents: total,
      ...recorded,
    })
  })
})
