import { expectedPayableLinesOf } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  as,
  createDraft,
  createSentOrder,
  moneyState,
  pay,
  setStock,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

interface Persona {
  id: number
  name: string
  role: string
}

describe('revision 17 identity and zero-total contracts', () => {
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

  it.each(['anonymous', 'admin'] as const)(
    'removes the full directory for %s callers',
    async (caller) => {
      const request = ctx.request.get('/api/users')
      if (caller === 'admin') request.set(as(ctx.seed.adminUserId))
      expect((await request).status).toBe(404)
    },
  )

  it.each(['anonymous', 'admin'] as const)(
    'exposes only seven minimal demo personas to %s callers with extra patients present',
    async (caller) => {
      // Extra real patient records must never turn the login list into a directory.
      await ctx.db.execute(sql`
      with extra as (insert into users (name, role) values ('Zzz Private Patient', 'patient') returning id)
      insert into patients (user_id, provider_id, date_of_birth, address)
      select id, (select id from providers where user_id = ${ctx.seed.providerUserId}), '1990-01-01', 'Private address' from extra`)
      const request = ctx.request.get('/api/users/sign-in-options')
      if (caller === 'admin') request.set(as(ctx.seed.adminUserId))
      const response = await request
      expect(response.status).toBe(200)
      const personas = response.body as Persona[]
      expect(personas.map(({ name, role }) => ({ name, role }))).toEqual([
        { name: 'Dr. Maya Rivera', role: 'provider' },
        { name: 'Jordan Lee', role: 'patient' },
        { name: 'Sam Patel', role: 'patient' },
        { name: 'Dr. Owen Brooks', role: 'provider' },
        { name: 'Alex Kim', role: 'patient' },
        { name: 'Riley Chen', role: 'patient' },
        { name: 'Ada Admin', role: 'admin' },
      ])
      personas.forEach((persona) =>
        expect(Object.keys(persona).sort()).toEqual(['id', 'name', 'role']),
      )
    },
  )

  it("restores every demo persona through /me with only that persona's own identity", async () => {
    const personas = (await ctx.request.get('/api/users/sign-in-options'))
      .body as Persona[]
    expect(personas).toHaveLength(7)
    await personas.reduce(async (previous, persona) => {
      await previous
      // Read the expected ids from the database, not from the endpoint under test.
      const identity = (
        await ctx.db.execute<{
          providerId: number | null
          patientId: number | null
        }>(sql`select p.id as "providerId", pt.id as "patientId"
      from users u left join providers p on p.user_id = u.id left join patients pt on pt.user_id = u.id where u.id = ${persona.id}`)
      ).rows[0]!
      const response = await ctx.request
        .get('/api/users/me')
        .set(as(persona.id))
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        id: persona.id,
        name: persona.name,
        role: persona.role,
      })
      expect(response.body.providerId ?? null).toBe(identity.providerId)
      expect(response.body.patientId ?? null).toBe(identity.patientId)
      // Identity only: no address, date of birth, provider or other patient data.
      expect(
        Object.keys(response.body).filter(
          (key) =>
            !['id', 'name', 'role', 'providerId', 'patientId'].includes(key),
        ),
      ).toEqual([])
    }, Promise.resolve())
  })

  it.each([undefined, 999999])(
    'rejects /me with missing or unknown identity (%s)',
    async (id) => {
      const request = ctx.request.get('/api/users/me')
      if (id !== undefined) request.set(as(id))
      const response = await request
      expect(response.status).toBe(401)
      expect(response.body.error.code).toBe('UNAUTHENTICATED')
    },
  )

  it.each(['anonymous', 'admin'] as const)(
    'denies patient and order reads to %s callers',
    async (caller) => {
      const id = await createSentOrder(ctx)
      await Promise.all(
        [
          '/api/patients',
          `/api/patients/${ctx.seed.patientId}`,
          '/api/orders',
          `/api/orders/${id}`,
        ].map(async (path) => {
          const request = ctx.request.get(path)
          if (caller === 'admin') request.set(as(ctx.seed.adminUserId))
          expect((await request).status).toBe(caller === 'admin' ? 403 : 401)
        }),
      )
    },
  )

  async function freeLine() {
    const product = (
      await ctx.db.execute<{
        id: number
      }>(sql`insert into products (sku, name, cogs_cents, stock_quantity)
      values ('REV17-FREE', 'Free sample', 0, 10) returning id`)
    ).rows[0]!
    return { productId: product.id, quantity: 1, unitPriceCents: 0 }
  }

  it('allows zero-priced drafts but rejects sending a zero total with the lines validation error', async () => {
    const id = await createDraft(ctx, [await freeLine()])
    const response = await ctx.request
      .post(`/api/orders/${id}/send`)
      .set(as(ctx.seed.providerUserId))
    expect(response.status).toBe(400)
    expect(response.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      field: 'lines',
      message: 'Order total must be greater than $0.00',
    })
    expect((await moneyState(ctx, id)).order?.status).toBe('draft')
    expect(ctx.notifier.sent).toEqual([])
  })

  async function assertNoZeroPayment(id: number, body: object = {}) {
    const before = await moneyState(ctx, id)
    const response = await pay(ctx, id, body)
    // Soft checks expose side effects even when the HTTP result is also wrong.
    expect.soft(response.status).toBe(409)
    expect.soft(response.body.error?.code).toBe('ORDER_CHANGED')
    expect.soft(await moneyState(ctx, id)).toEqual(before)
    expect
      .soft(
        (
          await ctx.db.execute(
            sql`select * from payment_attempts where order_id = ${id}`,
          )
        ).rows,
      )
      .toEqual([])
    expect.soft(ctx.gateway.charges).toEqual([])
    expect
      .soft(
        (await ctx.db.execute(sql`select * from fake_gateway_charges`)).rows,
      )
      .toEqual([])
  }

  it('rejects a SQL-seeded legacy zero-total payment before creating an attempt, holding stock or charging', async () => {
    const id = await createDraft(ctx, [await freeLine()])
    await ctx.db.execute(
      sql`update orders set status = 'pending_payment', revision = 1, sent_at = now(), subtotal_cents = 0, platform_fee_cents = 0, total_cents = 0 where id = ${id}`,
    )
    await assertNoZeroPayment(id)
  })

  it('rejects available-mode zero payable total before any attempt, hold or charge', async () => {
    const free = await freeLine()
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      free,
      { productId: product.id, quantity: 1, unitPriceCents: 2000 },
    ])
    await setStock(ctx, product.id, 0)
    const quote = await ctx.request
      .get(`/api/orders/${id}`)
      .set(as(ctx.seed.patientUserId))
    expect(quote.status).toBe(200)
    await assertNoZeroPayment(id, {
      mode: 'available',
      expectedTotalCents: 0,
      expectedPayableLines: expectedPayableLinesOf(quote.body.lines),
    })
  })
})
