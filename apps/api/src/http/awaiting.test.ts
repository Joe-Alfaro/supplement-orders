import { awaitingPaymentPageDtoSchema } from '@supplement-orders/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { orders } from '../db/schema'
import { as, createDraft, createSentOrder, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

describe('GET /api/orders?status=pending_payment', () => {
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

  function awaiting(query = '', userId = ctx.seed.providerUserId) {
    return ctx.request
      .get(`/api/orders?status=pending_payment${query}`)
      .set(as(userId))
  }

  /** Sends an order and pins its sentAt so ordering does not depend on timing. */
  async function sentOn(isoTime: string) {
    const orderId = await createSentOrder(ctx)
    await ctx.db
      .update(orders)
      .set({ sentAt: new Date(isoTime) })
      .where(eq(orders.id, orderId))
    return orderId
  }

  it('lists pending orders oldest first, with patient name and DOB', async () => {
    const newest = await sentOn('2026-10-05T09:00:00Z')
    const oldest = await sentOn('2026-10-01T09:00:00Z')
    const middle = await sentOn('2026-10-03T09:00:00Z')
    await createDraft(ctx)

    const res = await awaiting()

    expect(res.status).toBe(200)
    expect(awaitingPaymentPageDtoSchema.safeParse(res.body).success).toBe(true)
    expect(res.body).toMatchObject({ total: 3, offset: 0, limit: 25 })
    expect(res.body.items.map((o: { id: number }) => o.id)).toEqual([
      oldest,
      middle,
      newest,
    ])
    expect(res.body.items[0]).toEqual({
      id: oldest,
      patientId: ctx.seed.patientId,
      patientName: 'Jordan Lee',
      patientDateOfBirth: '1984-03-14',
      status: 'pending_payment',
      totalCents: expect.any(Number),
      createdAt: expect.any(String),
      sentAt: '2026-10-01T09:00:00.000Z',
      paidAt: null,
      cancelledAt: null,
    })
  })

  it('drops paid and cancelled orders and pages the rest', async () => {
    const paid = await sentOn('2026-10-01T09:00:00Z')
    const cancelled = await sentOn('2026-10-02T09:00:00Z')
    const a = await sentOn('2026-10-03T09:00:00Z')
    const b = await sentOn('2026-10-04T09:00:00Z')
    await pay(ctx, paid)
    await ctx.request
      .post(`/api/orders/${cancelled}/cancel`)
      .set(as(ctx.seed.providerUserId))

    const first = await awaiting('&limit=1')
    const second = await awaiting('&limit=1&offset=1')
    const past = await awaiting('&limit=1&offset=2')

    expect(first.body.items.map((o: { id: number }) => o.id)).toEqual([a])
    expect(second.body.items.map((o: { id: number }) => o.id)).toEqual([b])
    expect(past.body).toEqual({ items: [], total: 2, offset: 2, limit: 1 })
  })

  it('is scoped to the provider and closed to patients', async () => {
    await sentOn('2026-10-01T09:00:00Z')

    const other = await awaiting('', ctx.seed.otherProviderUserId)
    const patient = await awaiting('', ctx.seed.patientUserId)
    const othersPatient = await awaiting(
      `&patientId=${ctx.seed.patientId}`,
      ctx.seed.otherProviderUserId,
    )
    const mineFiltered = await awaiting(`&patientId=${ctx.seed.patientId}`)

    expect(other.body).toMatchObject({ items: [], total: 0 })
    expect(patient.status).toBe(403)
    expect(othersPatient.status).toBe(403)
    expect(mineFiltered.body.total).toBe(1)
  })

  it('rejects unknown status values and bad paging with a field', async () => {
    // Revision 8 accepts every order status and "all"; see order-list.test.ts.
    const results = await Promise.all(
      [
        '?status=bogus',
        '?status=PAID',
        '?status=pending_payment&limit=101',
      ].map((q) =>
        ctx.request.get(`/api/orders${q}`).set(as(ctx.seed.providerUserId)),
      ),
    )

    expect(results.map((r) => [r.status, r.body.error.field])).toEqual([
      [400, 'status'],
      [400, 'status'],
      [400, 'limit'],
    ])
  })

  it('leaves cancelled orders out of every dashboard metric', async () => {
    const paidId = await createSentOrder(ctx)
    const paid = await pay(ctx, paidId)
    const cancelledId = await createSentOrder(ctx)
    await ctx.request
      .post(`/api/orders/${cancelledId}/cancel`)
      .set(as(ctx.seed.providerUserId))

    const dashboard = await ctx.request
      .get('/api/dashboard')
      .set(as(ctx.seed.providerUserId))

    expect(dashboard.body.gmvCents).toBe(paid.body.totalCents)
    const paidList = await ctx.request
      .get('/api/orders?status=paid')
      .set(as(ctx.seed.providerUserId))
    expect(paidList.body.items.map((o: { id: number }) => o.id)).toEqual([
      paidId,
    ])
  })
})
