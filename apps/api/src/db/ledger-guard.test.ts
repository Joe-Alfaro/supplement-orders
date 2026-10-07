import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSentOrder, moneyState, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { ledgerEntries, payments } from './schema'

/** The Postgres SQLSTATE of a failed query, however drizzle wrapped it. */
function sqlState(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { code, cause } = err as { code?: unknown; cause?: unknown }
  if (typeof code === 'string') return code
  return sqlState(cause)
}

async function rejection(work: Promise<unknown>) {
  try {
    await work
  } catch (err) {
    return err
  }
  throw new Error('expected the database to reject this')
}

/** Integrity-constraint class (23xxx), as revision 11b requires. */
async function expectIntegrityViolation(work: Promise<unknown>) {
  const err = await rejection(work)
  expect(sqlState(err)).toMatch(/^23/)
  return err
}

// Revision 11b (audit L1): the ledger is append-only and balanced, enforced by
// the database itself (migration 0010), not only by the application.
describe('database-enforced ledger', () => {
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

  /** A normally paid order: one payment and its three balanced entries. */
  async function paidOrder() {
    const orderId = await createSentOrder(ctx)
    expect((await pay(ctx, orderId)).status).toBe(200)
    const state = await moneyState(ctx, orderId)
    return { orderId, payment: state.payments[0]!, ledger: state.ledger }
  }

  /** Inserts a payment by hand, with `entries` written in the same transaction. */
  function insertPayment(
    orderId: number,
    amountCents: number,
    entries: { type: string; amountCents: number; orderId?: number }[],
  ) {
    return ctx.db.transaction(async (tx) => {
      const key = `manual-${orderId}-${Date.now()}`
      const [payment] = await tx
        .insert(payments)
        .values({
          orderId,
          amountCents,
          idempotencyKey: key,
          gatewayReference: `ref-${key}`,
        })
        .returning({ id: payments.id })
      await Promise.all(
        entries.map((e) =>
          tx.execute(sql`
            insert into ledger_entries (order_id, payment_id, type, amount_cents)
            values (${e.orderId ?? orderId}, ${payment!.id}, ${e.type}, ${e.amountCents})`),
        ),
      )
    })
  }

  it('still lets a normal pay write its payment and three entries', async () => {
    const { payment, ledger } = await paidOrder()

    expect(ledger).toHaveLength(3)
    expect(ledger.reduce((s, e) => s + e.amountCents, 0)).toBe(
      payment.amountCents,
    )
  })

  it("rejects the audit's attack: raising the fee entry 15 -> 16", async () => {
    const { ledger } = await paidOrder()
    const fee = ledger.find((e) => e.type === 'platform_fee')!

    await expectIntegrityViolation(
      ctx.db
        .update(ledgerEntries)
        .set({ amountCents: fee.amountCents + 1 })
        .where(eq(ledgerEntries.id, fee.id)),
    )
    const after = await ctx.db
      .select({ amountCents: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, fee.id))
    expect(after[0]!.amountCents).toBe(fee.amountCents)
  })

  it('rejects deleting a ledger entry', async () => {
    const { ledger } = await paidOrder()

    await expectIntegrityViolation(
      ctx.db.delete(ledgerEntries).where(eq(ledgerEntries.id, ledger[0]!.id)),
    )
  })

  it('rejects updating or deleting a payment', async () => {
    const { payment } = await paidOrder()

    await expectIntegrityViolation(
      ctx.db
        .update(payments)
        .set({ amountCents: payment.amountCents + 1 })
        .where(eq(payments.id, payment.id)),
    )
    await expectIntegrityViolation(
      ctx.db.delete(payments).where(eq(payments.id, payment.id)),
    )
  })

  it('rejects a fourth entry for a balanced payment', async () => {
    const { orderId, payment } = await paidOrder()

    await expectIntegrityViolation(
      ctx.db.execute(sql`
        insert into ledger_entries (order_id, payment_id, type, amount_cents)
        values (${orderId}, ${payment.id}, 'platform_fee', 0)`),
    )
    expect((await moneyState(ctx, orderId)).ledger).toHaveLength(3)
  })

  it('rejects at commit a payment with no entries', async () => {
    const orderId = await createSentOrder(ctx)

    await expectIntegrityViolation(insertPayment(orderId, 1000, []))
    expect((await moneyState(ctx, orderId)).payments).toEqual([])
  })

  it('rejects at commit a payment with only some of its entries', async () => {
    const orderId = await createSentOrder(ctx)

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { type: 'cogs', amountCents: 900 },
        { type: 'platform_fee', amountCents: 100 },
      ]),
    )
  })

  it('rejects at commit entries that do not sum to the payment', async () => {
    const orderId = await createSentOrder(ctx)

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { type: 'cogs', amountCents: 800 },
        { type: 'provider_margin', amountCents: 150 },
        { type: 'platform_fee', amountCents: 8 },
      ]),
    )
    expect((await moneyState(ctx, orderId)).payments).toEqual([])
  })

  it("rejects at commit an entry on another order than its payment's", async () => {
    const orderId = await createSentOrder(ctx)
    const otherOrderId = await createSentOrder(ctx)

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { type: 'cogs', amountCents: 800 },
        { type: 'provider_margin', amountCents: 192 },
        { type: 'platform_fee', amountCents: 8, orderId: otherOrderId },
      ]),
    )
  })

  it('accepts a balanced payment written by hand, entries after the payment', async () => {
    const orderId = await createSentOrder(ctx)

    await insertPayment(orderId, 1000, [
      { type: 'cogs', amountCents: 800 },
      { type: 'provider_margin', amountCents: 192 },
      { type: 'platform_fee', amountCents: 8 },
    ])

    expect((await moneyState(ctx, orderId)).ledger).toHaveLength(3)
  })

  it('surfaces a tripped guard during pay as a 500 with everything rolled back', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)
    // Simulate an application bug: skew one fee entry as the app writes it, so
    // the ledger it commits no longer balances. Only the guard can catch this.
    await ctx.db.execute(sql`
      create or replace function test_skew_fee() returns trigger as $$
      begin
        if new.type = 'platform_fee' then new.amount_cents := new.amount_cents + 1; end if;
        return new;
      end $$ language plpgsql`)
    await ctx.db.execute(sql`
      create trigger test_skew_fee before insert on ledger_entries
      for each row execute function test_skew_fee()`)
    try {
      const res = await pay(ctx, orderId)

      expect([res.status, res.body.error.code]).toEqual([500, 'INTERNAL'])
      const after = await moneyState(ctx, orderId)
      expect(after.payments).toEqual([])
      expect(after.ledger).toEqual([])
      expect(after.order).toEqual(before.order)
    } finally {
      await ctx.db.execute(
        sql`drop trigger if exists test_skew_fee on ledger_entries`,
      )
      await ctx.db.execute(sql`drop function if exists test_skew_fee()`)
    }
  })

  it('keeps resets working: TRUNCATE does not fire the row triggers', async () => {
    await paidOrder()

    await ctx.reset()

    const [count] = (
      await ctx.db.execute<{ n: string }>(
        sql`select count(*)::text as n from ledger_entries`,
      )
    ).rows
    expect(count!.n).toBe('0')
  })
})
