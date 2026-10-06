import { providerOrderListPageDtoSchema } from '@supplement-orders/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { orders } from '../db/schema'
import { as, createDraft, createSentOrder, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

describe('revision 8: provider order list and patient latest-status filter', () => {
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

  const provider = () => as(ctx.seed.providerUserId)

  function list(query: string, userId = ctx.seed.providerUserId) {
    return ctx.request.get(`/api/orders?${query}`).set(as(userId))
  }

  function ids(body: { items: { id: number }[] }) {
    return body.items.map((o) => o.id)
  }

  /** Pins an order's timestamps so ordering does not depend on test timing. */
  async function pin(
    orderId: number,
    times: Partial<
      Record<'createdAt' | 'sentAt' | 'paidAt' | 'cancelledAt', string>
    >,
  ) {
    const set = Object.fromEntries(
      Object.entries(times).map(([key, value]) => [key, new Date(value)]),
    )
    await ctx.db.update(orders).set(set).where(eq(orders.id, orderId))
  }

  /**
   * Four orders whose latest activity runs paid (Oct 4), cancelled (Oct 3),
   * pending (sent Oct 2) and draft (created Oct 1).
   */
  async function fourStates() {
    const draft = await createDraft(ctx)
    await pin(draft, { createdAt: '2026-10-01T09:00:00Z' })
    const pending = await createSentOrder(ctx)
    await pin(pending, {
      createdAt: '2026-09-30T09:00:00Z',
      sentAt: '2026-10-02T09:00:00Z',
    })
    const cancelled = await createSentOrder(ctx)
    await ctx.request.post(`/api/orders/${cancelled}/cancel`).set(provider())
    await pin(cancelled, {
      createdAt: '2026-09-29T09:00:00Z',
      sentAt: '2026-09-29T10:00:00Z',
      cancelledAt: '2026-10-03T09:00:00Z',
    })
    const paid = await createSentOrder(ctx)
    await pay(ctx, paid)
    await pin(paid, {
      createdAt: '2026-09-28T09:00:00Z',
      sentAt: '2026-09-28T10:00:00Z',
      paidAt: '2026-10-04T09:00:00Z',
    })
    return { draft, pending, cancelled, paid }
  }

  it('lists all statuses by most recent activity first', async () => {
    const { draft, pending, cancelled, paid } = await fourStates()

    const res = await list('status=all')

    expect(res.status).toBe(200)
    expect(providerOrderListPageDtoSchema.safeParse(res.body).success).toBe(
      true,
    )
    expect(ids(res.body)).toEqual([paid, cancelled, pending, draft])
    expect(res.body.total).toBe(4)
    expect(res.body.items[3]).toMatchObject({
      status: 'draft',
      totalCents: null,
      sentAt: null,
      patientName: 'Jordan Lee',
      patientDateOfBirth: '1984-03-14',
    })
  })

  it('filters by each status', async () => {
    const { draft, pending, cancelled, paid } = await fourStates()

    const results = await Promise.all(
      ['draft', 'pending_payment', 'paid', 'cancelled'].map((status) =>
        list(`status=${status}`),
      ),
    )

    expect(results.map((r) => ids(r.body))).toEqual([
      [draft],
      [pending],
      [paid],
      [cancelled],
    ])
    expect(results[2]!.body.items[0].paidAt).toBe('2026-10-04T09:00:00.000Z')
    expect(results[3]!.body.items[0].cancelledAt).toBe(
      '2026-10-03T09:00:00.000Z',
    )
  })

  it('takes a comma-separated set of statuses (revision 8b)', async () => {
    const { draft, pending, cancelled, paid } = await fourStates()

    const allButPaid = await list('status=draft,pending_payment,cancelled')
    const withDuplicates = await list('status=paid,draft,paid')

    // Several statuses list by latest activity, even with pending_payment in the set.
    expect(ids(allButPaid.body)).toEqual([cancelled, pending, draft])
    expect(allButPaid.body.total).toBe(3)
    expect(ids(withDuplicates.body)).toEqual([paid, draft])
    expect(withDuplicates.body.total).toBe(2)
  })

  it.each([
    'status=',
    'status=all,paid',
    'status=draft,',
    'status=draft,bogus',
    'status=draft&status=paid',
  ])('rejects %s with a 400 on status', async (query) => {
    const res = await list(query)

    expect([res.status, res.body.error.field]).toEqual([400, 'status'])
  })

  it('lists awaiting payment oldest sent first, but drafts newest first', async () => {
    const olderPending = await createSentOrder(ctx)
    await pin(olderPending, { sentAt: '2026-10-01T09:00:00Z' })
    const newerPending = await createSentOrder(ctx)
    await pin(newerPending, { sentAt: '2026-10-05T09:00:00Z' })
    const olderDraft = await createDraft(ctx)
    await pin(olderDraft, { createdAt: '2026-10-01T09:00:00Z' })
    const newerDraft = await createDraft(ctx)
    await pin(newerDraft, { createdAt: '2026-10-05T09:00:00Z' })

    const pending = await list('status=pending_payment')
    const drafts = await list('status=draft')

    expect(ids(pending.body)).toEqual([olderPending, newerPending])
    expect(ids(drafts.body)).toEqual([newerDraft, olderDraft])
  })

  it('pages, scopes to the provider, and is closed to patients', async () => {
    await fourStates()

    const page = await list('status=all&limit=2&offset=2')
    const other = await list('status=all', ctx.seed.otherProviderUserId)
    const patient = await list('status=all', ctx.seed.patientUserId)
    const bogus = await list('status=bogus')

    expect(page.body).toMatchObject({ total: 4, offset: 2, limit: 2 })
    expect(page.body.items).toHaveLength(2)
    expect(other.body).toMatchObject({ items: [], total: 0 })
    expect(patient.status).toBe(403)
    expect([bogus.status, bogus.body.error.field]).toEqual([400, 'status'])
  })

  it('reflects reopen and delete', async () => {
    const reopened = await createSentOrder(ctx)
    await ctx.request.post(`/api/orders/${reopened}/cancel`).set(provider())
    await ctx.request.post(`/api/orders/${reopened}/reopen`).set(provider())
    const deleted = await createDraft(ctx)
    await ctx.request.delete(`/api/orders/${deleted}`).set(provider())

    const drafts = await list('status=draft')
    const cancelled = await list('status=cancelled')

    expect(ids(drafts.body)).toEqual([reopened])
    expect(drafts.body.items[0]).toMatchObject({
      sentAt: null,
      cancelledAt: null,
      totalCents: null,
    })
    expect(cancelled.body.total).toBe(0)
  })

  describe('GET /api/patients?latestStatus=', () => {
    function patients(query: string) {
      return ctx.request.get(`/api/patients?${query}`).set(provider())
    }

    function names(body: { items: { name: string }[] }) {
      return body.items.map((p) => p.name)
    }

    it('filters on the most recent order, with none for no orders', async () => {
      // Jordan Lee: an older paid order, then a newer draft. Sam Patel: none.
      const paid = await createSentOrder(ctx)
      await pay(ctx, paid)
      await pin(paid, { createdAt: '2026-10-01T09:00:00Z' })
      const draft = await createDraft(ctx)
      await pin(draft, { createdAt: '2026-10-02T09:00:00Z' })

      const none = await patients('latestStatus=none')
      const drafts = await patients('latestStatus=draft')
      const paidOnly = await patients('latestStatus=paid')
      const pending = await patients('latestStatus=pending_payment')

      expect(names(none.body)).toEqual(['Sam Patel'])
      expect(names(drafts.body)).toEqual(['Jordan Lee'])
      expect(drafts.body.items[0]).toMatchObject({
        orderCount: 2,
        latestOrderStatus: 'draft',
      })
      // Paid is not the latest order, so it does not match.
      expect(paidOnly.body.total).toBe(0)
      expect(pending.body.total).toBe(0)
    })

    it('combines with search and stays within the provider', async () => {
      await createDraft(ctx)

      const match = await patients('latestStatus=draft&q=jordan')
      const miss = await patients('latestStatus=draft&q=sam')
      const noneSearch = await patients('latestStatus=none&q=sam')
      const otherProvider = await ctx.request
        .get('/api/patients?latestStatus=none')
        .set(as(ctx.seed.otherProviderUserId))

      expect(names(match.body)).toEqual(['Jordan Lee'])
      expect(miss.body.total).toBe(0)
      expect(names(noneSearch.body)).toEqual(['Sam Patel'])
      expect(names(otherProvider.body)).toEqual(['Alex Kim', 'Riley Chen'])
    })

    it('rejects an unknown status with a field', async () => {
      const res = await patients('latestStatus=all')

      expect([res.status, res.body.error.field]).toEqual([400, 'latestStatus'])
    })
  })
})
