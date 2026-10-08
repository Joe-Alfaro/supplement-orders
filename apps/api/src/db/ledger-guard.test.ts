import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createSentOrder,
  insertSucceededAttempt,
  journalSplitOf,
  moneyState,
  pay,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  accounts,
  journals,
  payments,
  postings,
  products,
  providers,
  users,
} from './schema'

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

/** Integrity-constraint class (23xxx), as revisions 11b and 16 require. */
async function expectIntegrityViolation(work: Promise<unknown>) {
  const err = await rejection(work)
  expect(sqlState(err)).toMatch(/^23/)
  return err
}

interface ManualPosting {
  code: string
  amountCents: number
}

// Revision 16.2: the double-entry ledger is append-only, balanced and linked
// to its payment, enforced by the database itself (migration 0014).
describe('database-enforced double-entry ledger', () => {
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

  /** A normally paid order: one payment and its balanced journal. */
  async function paidOrder() {
    const orderId = await createSentOrder(ctx)
    expect((await pay(ctx, orderId)).status).toBe(200)
    const state = await moneyState(ctx, orderId)
    return {
      orderId,
      payment: state.payments[0]!,
      journal: state.journals[0]!,
      postings: state.postings,
    }
  }

  /**
   * Inserts a payment by hand in one transaction, with a journal (unless
   * `withJournal` is false) carrying `entries` by account code.
   */
  function insertPayment(
    orderId: number,
    amountCents: number,
    entries: ManualPosting[],
    options: { withJournal?: boolean; journalOrderId?: number } = {},
  ) {
    return ctx.db.transaction(async (tx) => {
      const key = `manual-${orderId}-${Date.now()}`
      const paymentAttemptId = await insertSucceededAttempt(tx, {
        orderId,
        amountCents,
        key,
      })
      const [payment] = await tx
        .insert(payments)
        .values({
          orderId,
          amountCents,
          idempotencyKey: key,
          gatewayReference: `ref-${key}`,
          paymentAttemptId,
        })
        .returning({ id: payments.id })
      if (options.withJournal === false) return
      const [journal] = await tx
        .insert(journals)
        .values({
          kind: 'patient_payment',
          paymentId: payment!.id,
          orderId: options.journalOrderId ?? orderId,
          memo: 'manual',
        })
        .returning({ id: journals.id })
      await Promise.all(
        entries.map((entry) =>
          tx.execute(sql`
            insert into postings (journal_id, account_id, amount_cents)
            select ${journal!.id}, id, ${entry.amountCents}
            from accounts where code = ${entry.code}`),
        ),
      )
    })
  }

  /**
   * Revision 17.3: the database checks a journal's split against the order's
   * lines, so hand-built journals are written for an order whose split is
   * exactly BALANCED: one $10.00 line of a product costing $8.00 (fee 8).
   */
  async function balancedOrder() {
    const [product] = await ctx.db
      .insert(products)
      .values({
        sku: `LEDGER-${Date.now()}-${Math.random()}`,
        name: 'Ledger fixture',
        cogsCents: 800,
        stockQuantity: 10,
      })
      .returning({ id: products.id })
    return createSentOrder(ctx, [
      { productId: product!.id, quantity: 1, unitPriceCents: 1000 },
    ])
  }

  // The seeded order belongs to provider 1, whose payable is 2100-1.
  const BALANCED: ManualPosting[] = [
    { code: '1000', amountCents: 1000 },
    { code: '4000', amountCents: -800 },
    { code: '2100-1', amountCents: -192 },
    { code: '4100', amountCents: -8 },
  ]

  it('still lets a normal pay write its payment and one balanced journal', async () => {
    const { payment, journal, postings: rows } = await paidOrder()

    expect(journal.paymentId).toBe(payment.id)
    expect(rows).toHaveLength(4)
    expect(journalSplitOf(rows).totalCents).toBe(payment.amountCents)
  })

  it("rejects the audit's attack: raising the fee credit by a cent", async () => {
    const { postings: rows } = await paidOrder()
    const fee = rows.find((p) => p.accountCode === '4100')!

    await expectIntegrityViolation(
      ctx.db
        .update(postings)
        .set({ amountCents: fee.amountCents - 1 })
        .where(eq(postings.id, fee.id)),
    )
    const [after] = await ctx.db
      .select({ amountCents: postings.amountCents })
      .from(postings)
      .where(eq(postings.id, fee.id))
    expect(after!.amountCents).toBe(fee.amountCents)
  })

  it('rejects deleting a posting', async () => {
    const { postings: rows } = await paidOrder()

    await expectIntegrityViolation(
      ctx.db.delete(postings).where(eq(postings.id, rows[0]!.id)),
    )
  })

  it('rejects updating or deleting a journal', async () => {
    const { journal } = await paidOrder()

    await expectIntegrityViolation(
      ctx.db
        .update(journals)
        .set({ memo: 'edited' })
        .where(eq(journals.id, journal.id)),
    )
    await expectIntegrityViolation(
      ctx.db.delete(journals).where(eq(journals.id, journal.id)),
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

  it('rejects changing or deleting an account, but allows a rename', async () => {
    await expectIntegrityViolation(
      ctx.db
        .update(accounts)
        .set({ code: '1001' })
        .where(eq(accounts.code, '1000')),
    )
    await expectIntegrityViolation(
      ctx.db.delete(accounts).where(eq(accounts.code, '4100')),
    )

    await ctx.db
      .update(accounts)
      .set({ name: 'Cash at bank' })
      .where(eq(accounts.code, '1000'))

    const [cash] = await ctx.db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.code, '1000'))
    expect(cash!.name).toBe('Cash at bank')
  })

  it('creates a payable account with every provider and renames it with the provider', async () => {
    const [user] = await ctx.db
      .insert(users)
      .values({ name: 'Dr. New Provider', role: 'provider' })
      .returning({ id: users.id })
    const [provider] = await ctx.db
      .insert(providers)
      .values({ userId: user!.id })
      .returning({ id: providers.id })

    const payable = () =>
      ctx.db
        .select({
          code: accounts.code,
          name: accounts.name,
          type: accounts.type,
          normalBalance: accounts.normalBalance,
        })
        .from(accounts)
        .where(eq(accounts.providerId, provider!.id))
    expect(await payable()).toEqual([
      {
        code: `2100-${provider!.id}`,
        name: 'Payable to Dr. New Provider',
        type: 'liability',
        normalBalance: 'credit',
      },
    ])

    await ctx.db
      .update(users)
      .set({ name: 'Dr. Renamed' })
      .where(eq(users.id, user!.id))
    expect((await payable())[0]!.name).toBe('Payable to Dr. Renamed')
  })

  it('accepts a balanced payment journal written by hand', async () => {
    const orderId = await balancedOrder()

    await insertPayment(orderId, 1000, BALANCED)

    expect((await moneyState(ctx, orderId)).postings).toHaveLength(4)
  })

  it('rejects at commit a payment without its journal', async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [], { withJournal: false }),
    )
    expect((await moneyState(ctx, orderId)).payments).toEqual([])
  })

  it('rejects at commit an unbalanced journal', async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { code: '1000', amountCents: 1000 },
        { code: '4000', amountCents: -800 },
        { code: '2100-1', amountCents: -150 },
        { code: '4100', amountCents: -8 },
      ]),
    )
    expect((await moneyState(ctx, orderId)).payments).toEqual([])
  })

  it('rejects at commit a single-posting journal', async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [{ code: '1000', amountCents: 1000 }]),
    )
  })

  it('rejects at commit a zero posting', async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { code: '1000', amountCents: 1000 },
        { code: '4000', amountCents: -1000 },
        { code: '4100', amountCents: 0 },
      ]),
    )
  })

  it("rejects a Cash posting that doesn't match the payment", async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { code: '1000', amountCents: 900 },
        { code: '4000', amountCents: -892 },
        { code: '4100', amountCents: -8 },
      ]),
    )
  })

  it('rejects a debit to an account other than Cash', async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { code: '1000', amountCents: 1000 },
        { code: '4000', amountCents: -1100 },
        { code: '4100', amountCents: 100 },
      ]),
    )
  })

  it("rejects crediting another provider's payable", async () => {
    const orderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, [
        { code: '1000', amountCents: 1000 },
        { code: '4000', amountCents: -800 },
        { code: '2100-2', amountCents: -192 },
        { code: '4100', amountCents: -8 },
      ]),
    )
  })

  it("rejects a journal on another order than its payment's", async () => {
    const orderId = await balancedOrder()
    const otherOrderId = await balancedOrder()

    await expectIntegrityViolation(
      insertPayment(orderId, 1000, BALANCED, { journalOrderId: otherOrderId }),
    )
  })

  it('rejects a posting added later to a paid journal', async () => {
    const { orderId, journal } = await paidOrder()

    await expectIntegrityViolation(
      ctx.db.execute(sql`
        insert into postings (journal_id, account_id, amount_cents)
        select ${journal.id}, id, -1 from accounts where code = '2100-2'`),
    )
    expect((await moneyState(ctx, orderId)).postings).toHaveLength(4)
  })

  it('surfaces a tripped guard during pay as a 500 with everything rolled back', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)
    // Simulate an application bug: skew the fee credit as the app writes it,
    // so the journal it commits no longer balances. Only the guard catches it.
    await ctx.db.execute(sql`
      create or replace function test_skew_fee() returns trigger as $$
      begin
        if new.account_id = (select id from accounts where code = '4100') then
          new.amount_cents := new.amount_cents - 1;
        end if;
        return new;
      end $$ language plpgsql`)
    await ctx.db.execute(sql`
      create trigger test_skew_fee before insert on postings
      for each row execute function test_skew_fee()`)
    try {
      const res = await pay(ctx, orderId)

      expect([res.status, res.body.error.code]).toEqual([500, 'INTERNAL'])
      const after = await moneyState(ctx, orderId)
      expect(after.payments).toEqual([])
      expect(after.journals).toEqual([])
      expect(after.postings).toEqual([])
      expect(after.order).toEqual(before.order)
    } finally {
      await ctx.db.execute(
        sql`drop trigger if exists test_skew_fee on postings`,
      )
      await ctx.db.execute(sql`drop function if exists test_skew_fee()`)
    }
  })

  it('keeps resets working: TRUNCATE skips the row triggers and restores the system accounts', async () => {
    await paidOrder()

    await ctx.reset()

    const [count] = (
      await ctx.db.execute<{ journals: string; postings: string }>(
        sql`select (select count(*) from journals)::text as journals,
                   (select count(*) from postings)::text as postings`,
      )
    ).rows
    expect(count).toEqual({ journals: '0', postings: '0' })
    const codes = await ctx.db
      .select({ id: accounts.id, code: accounts.code })
      .from(accounts)
      .orderBy(accounts.id)
    expect(codes).toEqual([
      { id: 1, code: '1000' },
      { id: 2, code: '4000' },
      { id: 3, code: '4100' },
      { id: 4, code: '2100-1' },
      { id: 5, code: '2100-2' },
    ])
  })
})
