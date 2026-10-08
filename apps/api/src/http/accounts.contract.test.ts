import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  as,
  createSentOrder,
  pay,
  withPaidOrdersUnfrozen,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Open envelope names resolved here: accounts => { accounts, totals };
// journals => { items, total, offset, limit }. Each journal uses the provider
// detail posting shape plus orderId and providerName (never a patient field).
interface Account {
  id: number
  code: string
  name: string
  type: string
  normalBalance: string
  providerId: number | null
  debitsCents: number
  creditsCents: number
  balanceCents: number
}
interface Journal {
  id: number
  orderId: number
  postedAt: string
  providerName: string
  postings: {
    accountCode: string
    accountName: string
    debitCents: number | null
    creditCents: number | null
  }[]
}

describe('revision 16 accounts, journals and dashboard HTTP contract', () => {
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
  function accounts() {
    return ctx.request.get('/api/admin/accounts').set(as(ctx.seed.adminUserId))
  }
  function journals(query = '') {
    return ctx.request
      .get(`/api/admin/journals${query}`)
      .set(as(ctx.seed.adminUserId))
  }
  async function paid(total: number, other = false) {
    const patient = (
      await ctx.db.execute<{
        id: number
        user_id: number
        provider_id: number
      }>(sql`
      select p.id, p.user_id, p.provider_id from patients p join providers v on v.id = p.provider_id
      where v.user_id = ${other ? ctx.seed.otherProviderUserId : ctx.seed.providerUserId} order by p.id limit 1`)
    ).rows[0]!
    const local = {
      ...ctx,
      seed: {
        ...ctx.seed,
        providerUserId: other
          ? ctx.seed.otherProviderUserId
          : ctx.seed.providerUserId,
        patientUserId: patient.user_id,
        patientId: patient.id,
      },
    }
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(local, [
      { productId: product.id, quantity: 1, unitPriceCents: total },
    ])
    expect((await pay(local, id)).status).toBe(200)
    const fee = Math.ceil((total * 75) / 10000)
    return {
      id,
      total,
      fee,
      cogs: product.cogsCents,
      margin: total - product.cogsCents - fee,
      providerId: patient.provider_id,
    }
  }
  it('includes all five system/provider accounts with zero balances before payment', async () => {
    const response = await accounts()
    expect(response.status).toBe(200)
    expect(response.body.totals).toEqual({ debitsCents: 0, creditsCents: 0 })
    const rows: Account[] = response.body.accounts
    expect(rows).toHaveLength(5)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: '1000',
          name: 'Cash',
          type: 'asset',
          normalBalance: 'debit',
          providerId: null,
        }),
        expect.objectContaining({
          code: '4000',
          name: 'Product sales at wholesale cost',
          type: 'revenue',
          normalBalance: 'credit',
          providerId: null,
        }),
        expect.objectContaining({
          code: '4100',
          name: 'Platform fee revenue',
          type: 'revenue',
          normalBalance: 'credit',
          providerId: null,
        }),
      ]),
    )
    const providers = (
      await ctx.db.execute<{ id: number; name: string }>(
        sql`select p.id, u.name from providers p join users u on u.id = p.user_id`,
      )
    ).rows
    providers.forEach((provider) =>
      expect(rows).toContainEqual(
        expect.objectContaining({
          code: `2100-${provider.id}`,
          name: `Payable to ${provider.name}`,
          providerId: provider.id,
          type: 'liability',
          normalBalance: 'credit',
        }),
      ),
    )
    rows.forEach((row) =>
      expect(row).toMatchObject({
        debitsCents: 0,
        creditsCents: 0,
        balanceCents: 0,
      }),
    )
  })
  it('trial balance and payable balances reconcile several payments across both providers', async () => {
    const first = await paid(12000)
    const second = await paid(2000)
    const other = await paid(5000, true)
    // An unpaid order has no accounting impact.
    await createSentOrder(ctx)
    const response = await accounts()
    expect(response.status).toBe(200)
    expect(response.body.totals).toEqual({
      debitsCents: 19000,
      creditsCents: 19000,
    })
    const rows: Account[] = response.body.accounts
    const expected = [
      ['1000', 19000, 0, 19000],
      ['4000', 0, first.cogs * 3, first.cogs * 3],
      [
        '4100',
        0,
        first.fee + second.fee + other.fee,
        first.fee + second.fee + other.fee,
      ],
      [
        `2100-${first.providerId}`,
        0,
        first.margin + second.margin,
        first.margin + second.margin,
      ],
      [`2100-${other.providerId}`, 0, other.margin, other.margin],
    ] as const
    expected.forEach(([code, debitsCents, creditsCents, balanceCents]) =>
      expect(rows.find((row) => row.code === code)).toMatchObject({
        debitsCents,
        creditsCents,
        balanceCents,
      }),
    )
    expect(rows.reduce((sum, row) => sum + row.debitsCents, 0)).toBe(19000)
    expect(rows.reduce((sum, row) => sum + row.creditsCents, 0)).toBe(19000)
    await Promise.all(
      [
        [ctx.seed.providerUserId, first.margin + second.margin],
        [ctx.seed.otherProviderUserId, other.margin],
      ].map(async ([user, owed]) => {
        const dashboard = await ctx.request
          .get('/api/dashboard?range=all')
          .set(as(user!))
        expect(dashboard.status).toBe(200)
        expect(dashboard.body.owedToYouCents).toBe(owed)
      }),
    )
  })
  it('date-ranged dashboard retains fixture values while owedToYouCents stays all time', async () => {
    const old = await paid(12000)
    const current = await paid(2000)
    await paid(5000, true)
    await withPaidOrdersUnfrozen(ctx.db, async (tx) => {
      await tx.execute(
        sql`update orders set paid_at = '2026-01-15T12:00:00Z' where id = ${old.id}`,
      )
      await tx.execute(
        sql`update orders set paid_at = '2026-02-15T12:00:00Z' where id = ${current.id}`,
      )
    })
    const response = await ctx.request
      .get('/api/dashboard?range=custom&from=2026-02-01&to=2026-02-28&tz=UTC')
      .set(as(ctx.seed.providerUserId))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      gmvCents: 2000,
      providerMarginCents: current.margin,
      platformFeeCents: 15,
      owedToYouCents: old.margin + current.margin,
    })
    const empty = await ctx.request
      .get('/api/dashboard?range=custom&from=2020-01-01&to=2020-01-02&tz=UTC')
      .set(as(ctx.seed.providerUserId))
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({
      gmvCents: 0,
      providerMarginCents: 0,
      platformFeeCents: 0,
      owedToYouCents: old.margin + current.margin,
    })
    const source = (
      await ctx.db.execute<{ margin: string }>(
        sql`select (-sum(p.amount_cents))::text as margin from postings p join accounts a on a.id = p.account_id where a.provider_id = ${old.providerId}`,
      )
    ).rows[0]!
    expect(response.body.owedToYouCents).toBe(Number(source.margin))
  })
  it('paginates journals newest first, with order identity, names and balanced display postings', async () => {
    const first = await paid(12000)
    const second = await paid(2000, true)
    const third = await paid(3000)
    const response = await journals('?offset=0&limit=2')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ total: 3, offset: 0, limit: 2 })
    const items: Journal[] = response.body.items
    expect(items.map((item) => item.orderId)).toEqual([third.id, second.id])
    items.forEach((journal) => {
      expect(Number.isNaN(Date.parse(journal.postedAt))).toBe(false)
      expect(
        Object.keys(journal).filter((key) => /patient/i.test(key)),
      ).toEqual([])
      expect(JSON.stringify(journal)).not.toMatch(/Jordan Lee|Alex Kim/)
      expect(journal.providerName).toBe(
        journal.orderId === second.id ? 'Dr. Owen Brooks' : 'Dr. Maya Rivera',
      )
      expect(journal.postings.length).toBeGreaterThanOrEqual(2)
      journal.postings.forEach((p) => {
        expect(p.accountCode.length).toBeGreaterThan(0)
        expect(p.accountName.length).toBeGreaterThan(0)
        expect((p.debitCents === null) !== (p.creditCents === null)).toBe(true)
        expect(Number.isSafeInteger(p.debitCents ?? p.creditCents)).toBe(true)
        expect(p.debitCents ?? p.creditCents).toBeGreaterThan(0)
      })
      expect(
        journal.postings.reduce((sum, p) => sum + (p.debitCents ?? 0), 0),
      ).toBe(journal.postings.reduce((sum, p) => sum + (p.creditCents ?? 0), 0))
    })
    const next = await journals('?offset=2&limit=2')
    expect(next.status).toBe(200)
    expect(next.body).toMatchObject({
      total: 3,
      offset: 2,
      limit: 2,
      items: [{ orderId: first.id }],
    })
    expect(next.body.items).toHaveLength(1)
    const beyond = await journals('?offset=3&limit=2')
    expect(beyond.status).toBe(200)
    expect(beyond.body.items).toEqual([])
  })
  it.each(['/api/admin/accounts', '/api/admin/journals'])(
    '%s rejects providers, patients and anonymous callers',
    async (url) => {
      await Promise.all(
        [
          ctx.seed.providerUserId,
          ctx.seed.otherProviderUserId,
          ctx.seed.patientUserId,
        ].map(async (user) => {
          expect((await ctx.request.get(url).set(as(user))).status).toBe(403)
        }),
      )
      expect((await ctx.request.get(url)).status).toBe(401)
    },
  )
})
