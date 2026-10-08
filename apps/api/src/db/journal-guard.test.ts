import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { as, createSentOrder, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  return typeof code === 'string' ? code : sqlState(cause)
}
async function integrity(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(sqlState(error) ?? 'NO_SQLSTATE').toMatch(/^23/)
}

describe('revision 16 direct SQL journal guards', () => {
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
    const id = await createSentOrder(ctx)
    const detail = await ctx.request
      .get(`/api/orders/${id}`)
      .set(as(ctx.seed.providerUserId))
    expect(detail.status).toBe(200)
    return {
      id,
      split: detail.body.split as {
        totalCents: number
        cogsCents: number
        providerMarginCents: number
        platformFeeCents: number
      },
      providerId: detail.body.providerId as number,
    }
  }
  async function manual(
    mode:
      | 'valid'
      | 'missing'
      | 'empty'
      | 'single'
      | 'zero'
      | 'unbalanced'
      | 'cash'
      | 'provider',
  ) {
    const { id, split, providerId } = await fixture()
    const reached = { end: false }
    const work = ctx.db.transaction(async (tx) => {
      const payment = (
        await tx.execute<{ id: number }>(
          sql`insert into payments (order_id, amount_cents, idempotency_key, gateway_reference) values (${id}, ${split.totalCents}, ${`manual-${id}`}, ${`ref-${id}`}) returning id`,
        )
      ).rows[0]!
      if (mode !== 'missing') {
        const journal = (
          await tx.execute<{ id: number }>(
            sql`insert into journals (kind, payment_id, order_id, memo) values ('patient_payment', ${payment.id}, ${id}, 'Direct SQL fixture') returning id`,
          )
        ).rows[0]!
        const values =
          mode === 'empty'
            ? []
            : ([
                ['1000', split.totalCents + (mode === 'cash' ? 1 : 0)],
                ['4000', -split.cogsCents],
                [
                  `2100-${mode === 'provider' ? providerId + 1 : providerId}`,
                  -split.providerMarginCents - (mode === 'cash' ? 1 : 0),
                ],
                [
                  '4100',
                  -split.platformFeeCents + (mode === 'unbalanced' ? 1 : 0),
                ],
              ] as [string, number][])
        const selected = mode === 'single' ? values.slice(0, 1) : values
        await selected.reduce(async (previous, [code, amount]) => {
          await previous
          await tx.execute(
            sql`insert into postings (journal_id, account_id, amount_cents) values (${journal.id}, (select id from accounts where code = ${code}), ${amount})`,
          )
        }, Promise.resolve())
        if (mode === 'zero')
          await tx.execute(
            sql`insert into postings (journal_id, account_id, amount_cents) values (${journal.id}, (select id from accounts where code = '1000'), 0)`,
          )
      }
      reached.end = true
    })
    if (mode === 'valid') await work
    else await integrity(work)
    // Zero may fail immediately via CHECK; the balance/linkage guards must defer.
    if (mode !== 'zero') expect(reached.end).toBe(true)
    const rows = (
      await ctx.db.execute(sql`select id from payments where order_id = ${id}`)
    ).rows
    expect(rows).toHaveLength(mode === 'valid' ? 1 : 0)
  }
  it('accepts a complete balanced journal inserted after its payment in one transaction', async () => {
    await manual('valid')
  })
  it.each([
    'missing',
    'empty',
    'single',
    'zero',
    'unbalanced',
    'cash',
    'provider',
  ] as const)('rejects %s at commit (zero may fail earlier)', async (mode) => {
    await manual(mode)
  })

  it.each(['postings', 'journals', 'accounts', 'payments'] as const)(
    'rejects UPDATE and DELETE of %s with class 23',
    async (table) => {
      const id = await createSentOrder(ctx)
      expect((await pay(ctx, id)).status).toBe(200)
      const before = (
        await ctx.db.execute(
          sql`select * from ${sql.identifier(table)} order by id`,
        )
      ).rows
      expect(before.length).toBeGreaterThan(0)
      const assignments = {
        postings: sql`amount_cents = amount_cents + 1`,
        journals: sql`memo = 'tampered'`,
        accounts: sql`code = code || '-tampered'`,
        payments: sql`amount_cents = amount_cents + 1`,
      }
      await integrity(
        ctx.db.execute(
          sql`update ${sql.identifier(table)} set ${assignments[table]}`,
        ),
      )
      await integrity(ctx.db.execute(sql`delete from ${sql.identifier(table)}`))
      expect(
        (
          await ctx.db.execute(
            sql`select * from ${sql.identifier(table)} order by id`,
          )
        ).rows,
      ).toEqual(before)
    },
  )
  it('rejects deleting an unused account, without relying on posting foreign keys', async () => {
    await ctx.db.execute(
      sql`insert into accounts (code, name, type, normal_balance) values ('3999', 'Unused equity', 'equity', 'credit')`,
    )
    await integrity(
      ctx.db.execute(sql`delete from accounts where code = '3999'`),
    )
  })

  it('rejects journal deletion immediately even before postings exist', async () => {
    const { id, split } = await fixture()
    const reached = { deletion: false }
    await integrity(
      ctx.db.transaction(async (tx) => {
        const payment = (
          await tx.execute<{ id: number }>(
            sql`insert into payments (order_id, amount_cents, idempotency_key, gateway_reference) values (${id}, ${split.totalCents}, 'delete-test', 'delete-test') returning id`,
          )
        ).rows[0]!
        const journal = (
          await tx.execute<{ id: number }>(
            sql`insert into journals (kind, payment_id, order_id, memo) values ('patient_payment', ${payment.id}, ${id}, 'Delete test') returning id`,
          )
        ).rows[0]!
        await tx.execute(sql`delete from journals where id = ${journal.id}`)
        reached.deletion = true
      }),
    )
    expect(reached.deletion).toBe(false)
  })

  it('allows account name-only updates but rejects changes to accounting identity', async () => {
    await ctx.db.execute(
      sql`update accounts set name = 'Renamed Cash' where code = '1000'`,
    )
    expect(
      (await ctx.db.execute(sql`select name from accounts where code = '1000'`))
        .rows,
    ).toEqual([{ name: 'Renamed Cash' }])
    await integrity(
      ctx.db.execute(
        sql`update accounts set name = 'Other', normal_balance = 'credit' where code = '1000'`,
      ),
    )
    await integrity(
      ctx.db.execute(
        sql`update accounts set type = 'equity' where code = '1000'`,
      ),
    )
  })
  it('keeps TRUNCATE resets working and removes the obsolete ledger table', async () => {
    expect((await pay(ctx, await createSentOrder(ctx))).status).toBe(200)
    await ctx.reset()
    expect((await ctx.db.execute(sql`select * from journals`)).rows).toEqual([])
    expect((await ctx.db.execute(sql`select * from postings`)).rows).toEqual([])
    expect(
      (
        await ctx.db.execute(
          sql`select to_regclass('public.ledger_entries') as legacy`,
        )
      ).rows,
    ).toEqual([{ legacy: null }])
  })
})
