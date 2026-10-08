import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSentOrder, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  return typeof code === 'string' ? code : sqlState(cause)
}
async function sqlStateOf(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  return sqlState(error) ?? 'NO_ERROR'
}

// Revision 18: L7 (frozen referenced attempts) and migration 0016 (18.1 index, 18.2 enum).
describe('revision 18 direct SQL guards', () => {
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

  async function paidAttempt() {
    const id = await createSentOrder(ctx)
    expect((await pay(ctx, id)).status).toBe(200)
    const row = (
      await ctx.db.execute<{ id: number }>(
        sql`select payment_attempt_id as id from payments where order_id = ${id}`,
      )
    ).rows[0]!
    return { orderId: id, attemptId: row.id }
  }

  it.each([
    ['status', sql`status = 'declined'`],
    ['amount', sql`amount_cents = amount_cents + 1`],
    ['stock_held', sql`stock_held = not stock_held`],
    ['updated_at', sql`updated_at = now()`],
  ])(
    'L7 UPDATE of %s on an attempt a payment references is rejected',
    async (_name, set) => {
      const { attemptId } = await paidAttempt()
      expect(
        await sqlStateOf(
          ctx.db.execute(
            sql`update payment_attempts set ${set} where id = ${attemptId}`,
          ),
        ),
      ).toMatch(/^23/)
      expect(
        (
          await ctx.db.execute(
            sql`select status from payment_attempts where id = ${attemptId}`,
          )
        ).rows,
      ).toEqual([{ status: 'succeeded' }])
    },
  )

  it('L7 DELETE of an attempt a payment references is rejected', async () => {
    const { attemptId } = await paidAttempt()
    expect(
      await sqlStateOf(
        ctx.db.execute(
          sql`delete from payment_attempts where id = ${attemptId}`,
        ),
      ),
    ).toMatch(/^23/)
    expect(
      (
        await ctx.db.execute(
          sql`select id from payment_attempts where id = ${attemptId}`,
        )
      ).rows,
    ).toHaveLength(1)
  })

  it('L7 attempts that no payment references stay writable', async () => {
    const id = await createSentOrder(ctx)
    const attempt = (
      await ctx.db.execute<{ id: number }>(sql`insert into payment_attempts
        (order_id, revision, execution, idempotency_key, amount_cents, status, stock_held)
        select id, revision, 1, 'rev18-unreferenced', total_cents, 'pending', true from orders where id = ${id}
        returning id`)
    ).rows[0]!
    await ctx.db.execute(
      sql`update payment_attempts set status = 'declined', stock_held = false where id = ${attempt.id}`,
    )
    await ctx.db.execute(
      sql`delete from payment_attempts where id = ${attempt.id}`,
    )
    expect(
      (await ctx.db.execute(sql`select id from payment_attempts`)).rows,
    ).toEqual([])
  })

  it('0016 accepts the abandoned attempt status', async () => {
    const id = await createSentOrder(ctx)
    await ctx.db.execute(sql`insert into payment_attempts
      (order_id, revision, execution, idempotency_key, amount_cents, status, stock_held)
      select id, revision, 1, 'rev18-abandoned', total_cents, 'abandoned', false from orders where id = ${id}`)
    expect(
      (
        await ctx.db.execute(
          sql`select status from payment_attempts where order_id = ${id}`,
        )
      ).rows,
    ).toEqual([{ status: 'abandoned' }])
  })

  async function child(parentId: number, status: string, key: number) {
    return ctx.db.execute(sql`insert into orders
      (provider_id, patient_id, status, subtotal_cents, platform_fee_cents, total_cents, revision, split_from_order_id, split_from_revision, sent_at, cancelled_at)
      select provider_id, patient_id, ${status}::order_status, 1000, 8, 1000, 1, ${parentId}, ${key}, now(), case when ${status}::order_status = 'cancelled' then now() end
      from orders where id = ${parentId}`)
  }

  it('0016 allows a cancelled and a live back-order of the same order but not two live ones', async () => {
    const parent = await createSentOrder(ctx)
    await child(parent, 'cancelled', 1)
    await child(parent, 'cancelled', 1)
    await child(parent, 'pending_payment', 1)
    expect(await sqlStateOf(child(parent, 'pending_payment', 1))).toBe('23505')
  })
})
