import { rmSync } from 'node:fs'
import {
  adminTrialBalanceDtoSchema,
  USER_ID_HEADER,
} from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import supertest from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakePaymentGateway, RecordingNotifier } from '../seams'
import { createApp } from '../server'
import { createDb, type Db } from './client'
import {
  migrationsThrough,
  recreateDatabase,
  scratchUrl,
} from '../testing/scratch-db'
import { runMigrations } from './migrate'

// Revision 16.7: the real 0014 backfill. A scratch database is migrated to
// 0013 only, given pre-0014 payments and ledger rows, then migrated to 0014.
// (These hand-built payments predate attempts, so 0015 would reject them; its
// own test covers that.)

const LAST_PRE_JOURNAL_MIGRATION = 13
const JOURNAL_MIGRATION = 14

interface OldPayment {
  orderId: number
  amountCents: number
  cogsCents: number
  marginCents: number
  feeCents: number
}

// Provider 1 (user 1): a normal payment and a zero-margin one. Provider 2
// (user 4): a back-order chain, original (order 3) then back-order (order 4).
const OLD_PAYMENTS: OldPayment[] = [
  {
    orderId: 1,
    amountCents: 12000,
    cogsCents: 7000,
    marginCents: 4910,
    feeCents: 90,
  },
  { orderId: 2, amountCents: 67, cogsCents: 66, marginCents: 0, feeCents: 1 },
  {
    orderId: 3,
    amountCents: 2000,
    cogsCents: 1500,
    marginCents: 485,
    feeCents: 15,
  },
  {
    orderId: 4,
    amountCents: 1000,
    cogsCents: 750,
    marginCents: 242,
    feeCents: 8,
  },
]

const ORDERS = [
  { id: 1, providerId: 1, patientId: 1 },
  { id: 2, providerId: 1, patientId: 1 },
  { id: 3, providerId: 2, patientId: 2 },
  { id: 4, providerId: 2, patientId: 2, splitFrom: 3 },
]

async function seedPre0014(db: Db) {
  await db.execute(sql`
    insert into users (id, name, role) values
      (1, 'Dr. Ann Old', 'provider'), (2, 'Pat One', 'patient'),
      (3, 'Pat Two', 'patient'), (4, 'Dr. Ben Old', 'provider'),
      (5, 'Ada Admin', 'admin');
    insert into providers (id, user_id) values (1, 1), (2, 4);
    insert into patients (id, user_id, provider_id, date_of_birth, address) values
      (1, 2, 1, '1980-01-01', '1 Main St'), (2, 3, 2, '1990-02-02', '2 Main St');
    insert into orders (id, provider_id, patient_id, status, revision, sent_at,
      subtotal_cents, platform_fee_cents, total_cents)
    values (5, 1, 1, 'pending_payment', 1, now(), 500, 4, 500)`)
  // In order: a back-order references its original.
  await ORDERS.reduce(async (previous, order, i) => {
    await previous
    const paid = OLD_PAYMENTS[i]!
    await db.transaction(async (tx) => {
      await tx.execute(sql`
          insert into orders (id, provider_id, patient_id, status, revision,
            sent_at, paid_at, subtotal_cents, platform_fee_cents, total_cents,
            split_from_order_id, split_from_revision)
          values (${order.id}, ${order.providerId}, ${order.patientId}, 'paid', 1,
            now(), now() - make_interval(days => ${i}), ${paid.amountCents},
            ${paid.feeCents}, ${paid.amountCents}, ${order.splitFrom ?? null},
            ${order.splitFrom === undefined ? null : 1})`)
      const payment = await tx.execute<{ id: number }>(sql`
          insert into payments (order_id, amount_cents, idempotency_key, gateway_reference)
          values (${order.id}, ${paid.amountCents}, ${`old-${order.id}`}, ${`ref-${order.id}`})
          returning id`)
      const paymentId = payment.rows[0]!.id
      await tx.execute(sql`
          insert into ledger_entries (order_id, payment_id, type, amount_cents) values
            (${order.id}, ${paymentId}, 'cogs', ${paid.cogsCents}),
            (${order.id}, ${paymentId}, 'provider_margin', ${paid.marginCents}),
            (${order.id}, ${paymentId}, 'platform_fee', ${paid.feeCents})`)
    })
  }, Promise.resolve())
  // Explicit ids above; move the sequences past them like real inserts would.
  await db.execute(sql`
    select setval('users_id_seq', 5); select setval('providers_id_seq', 2);
    select setval('patients_id_seq', 2); select setval('orders_id_seq', 5)`)
}

/** The revision 11 dashboard query, read from the old ledger. */
async function oldDashboard(db: Db, providerId: number) {
  const result = await db.execute<Record<string, string>>(sql`
    select
      (select coalesce(sum(p.amount_cents), 0)::text from payments p
         join orders o on o.id = p.order_id
        where o.provider_id = ${providerId} and o.status = 'paid') as gmv,
      (select coalesce(sum(l.amount_cents), 0)::text from ledger_entries l
         join orders o on o.id = l.order_id
        where o.provider_id = ${providerId} and o.status = 'paid'
          and l.type = 'provider_margin') as margin,
      (select coalesce(sum(l.amount_cents), 0)::text from ledger_entries l
         join orders o on o.id = l.order_id
        where o.provider_id = ${providerId} and o.status = 'paid'
          and l.type = 'platform_fee') as fee`)
  const row = result.rows[0]!
  return {
    gmvCents: Number(row.gmv),
    providerMarginCents: Number(row.margin),
    platformFeeCents: Number(row.fee),
  }
}

describe('migration 0014: ledger_entries backfilled into journals', () => {
  const url = scratchUrl('mig0014')
  const scratch = { db: null as Db | null, pool: null as pg.Pool | null }
  const partial = migrationsThrough(LAST_PRE_JOURNAL_MIGRATION)
  const throughJournal = migrationsThrough(JOURNAL_MIGRATION)
  const before = {
    dashboards: [] as Awaited<ReturnType<typeof oldDashboard>>[],
  }

  function db() {
    if (!scratch.db) throw new Error('scratch database not ready')
    return scratch.db
  }

  beforeAll(async () => {
    await recreateDatabase(url)
    const created = createDb(url)
    scratch.db = created.db
    scratch.pool = created.pool
    await runMigrations(created.db, partial)
    await seedPre0014(created.db)
    before.dashboards = [
      await oldDashboard(created.db, 1),
      await oldDashboard(created.db, 2),
    ]
    await runMigrations(created.db, throughJournal)
  }, 120_000)

  afterAll(async () => {
    await scratch.pool?.end()
    rmSync(partial, { recursive: true, force: true })
    rmSync(throughJournal, { recursive: true, force: true })
  })

  async function rows<T extends Record<string, unknown>>(
    query: ReturnType<typeof sql>,
  ) {
    return (await db().execute<T>(query)).rows
  }

  it('drops ledger_entries and its type', async () => {
    expect(
      await rows(sql`select to_regclass('ledger_entries')::text as t`),
    ).toEqual([{ t: null }])
    expect(
      await rows(
        sql`select count(*)::int as n from pg_type where typname = 'ledger_entry_type'`,
      ),
    ).toEqual([{ n: 0 }])
  })

  it('creates the system accounts and a payable for every provider', async () => {
    expect(
      await rows(sql`
        select code, name, type::text, normal_balance::text as normal, provider_id
        from accounts order by code`),
    ).toEqual([
      {
        code: '1000',
        name: 'Cash',
        type: 'asset',
        normal: 'debit',
        provider_id: null,
      },
      {
        code: '2100-1',
        name: 'Payable to Dr. Ann Old',
        type: 'liability',
        normal: 'credit',
        provider_id: 1,
      },
      {
        code: '2100-2',
        name: 'Payable to Dr. Ben Old',
        type: 'liability',
        normal: 'credit',
        provider_id: 2,
      },
      {
        code: '4000',
        name: 'Product sales at wholesale cost',
        type: 'revenue',
        normal: 'credit',
        provider_id: null,
      },
      {
        code: '4100',
        name: 'Platform fee revenue',
        type: 'revenue',
        normal: 'credit',
        provider_id: null,
      },
    ])
  })

  it('turns each payment and its ledger rows into one balanced journal with matching postings', async () => {
    const journals = await rows<{
      order_id: number
      payment_id: number
      kind: string
    }>(sql`
      select j.order_id, j.payment_id, j.kind::text as kind
      from journals j order by j.order_id`)
    const payments = await rows<{ id: number; order_id: number }>(
      sql`select id, order_id from payments order by order_id`,
    )
    expect(journals).toEqual(
      payments.map((p) => ({
        order_id: p.order_id,
        payment_id: p.id,
        kind: 'patient_payment',
      })),
    )

    const postings = await rows<{
      order_id: number
      code: string
      amount: string
    }>(sql`
      select j.order_id, a.code, ps.amount_cents::text as amount
      from postings ps
      join journals j on j.id = ps.journal_id
      join accounts a on a.id = ps.account_id
      order by j.order_id, ps.id`)
    const expected = OLD_PAYMENTS.flatMap((old) => {
      const providerId = ORDERS.find((o) => o.id === old.orderId)!.providerId
      return [
        ['1000', old.amountCents],
        ['4000', -old.cogsCents],
        [`2100-${providerId}`, -old.marginCents],
        ['4100', -old.feeCents],
      ]
        .filter(([, amount]) => amount !== 0)
        .map(([code, amount]) => ({
          order_id: old.orderId,
          code,
          amount: String(amount),
        }))
    })
    expect(postings).toEqual(expected)
    // The zero-margin payment has no payable posting.
    expect(postings.filter((p) => p.order_id === 2).map((p) => p.code)).toEqual(
      ['1000', '4000', '4100'],
    )
  })

  it('keeps the trial balance, dashboard and paid splits equal to the old ledger', async () => {
    const app = supertest(
      createApp({
        db: db(),
        gateway: new FakePaymentGateway(db()),
        notifier: new RecordingNotifier(),
        pingDb: async () => {},
        nodeEnv: 'test',
      }),
    )

    const trial = adminTrialBalanceDtoSchema.parse(
      (await app.get('/api/admin/accounts').set(USER_ID_HEADER, '5')).body,
    )
    expect(trial.totals.debitsCents).toBe(trial.totals.creditsCents)
    expect(trial.totals.debitsCents).toBe(
      OLD_PAYMENTS.reduce((sum, p) => sum + p.amountCents, 0),
    )

    const dashboards = await Promise.all(
      [1, 4].map(
        async (userId) =>
          (
            await app
              .get('/api/dashboard')
              .query({ range: 'all' })
              .set(USER_ID_HEADER, String(userId))
          ).body,
      ),
    )
    dashboards.forEach((dashboard, i) => {
      expect(dashboard).toMatchObject(before.dashboards[i]!)
      expect(dashboard.owedToYouCents).toBe(
        before.dashboards[i]!.providerMarginCents,
      )
    })

    const detail = await app.get('/api/orders/2').set(USER_ID_HEADER, '1')
    expect(detail.body.split).toEqual({
      subtotalCents: 67,
      totalCents: 67,
      cogsCents: 66,
      providerMarginCents: 0,
      platformFeeCents: 1,
    })
  })

  it('keeps enforcing the guards on backfilled rows', async () => {
    await expect(
      db().execute(sql`update postings set amount_cents = amount_cents - 1
        where account_id = (select id from accounts where code = '4100')`),
    ).rejects.toThrow()
    await expect(db().execute(sql`delete from journals`)).rejects.toThrow()
  })
})
