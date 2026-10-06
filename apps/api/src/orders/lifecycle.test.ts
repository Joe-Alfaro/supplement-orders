import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { orderItems, orders } from '../db/schema'
import {
  as,
  createDraft,
  createSentOrder,
  moneyState,
  pay,
  sampleLines,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

describe('revision 8: delete draft and reopen cancelled', () => {
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

  function remove(orderId: number, userId = ctx.seed.providerUserId) {
    return ctx.request.delete(`/api/orders/${orderId}`).set(as(userId))
  }

  function reopen(orderId: number, userId = ctx.seed.providerUserId) {
    return ctx.request.post(`/api/orders/${orderId}/reopen`).set(as(userId))
  }

  function cancel(orderId: number) {
    return ctx.request.post(`/api/orders/${orderId}/cancel`).set(provider())
  }

  function send(orderId: number) {
    return ctx.request.post(`/api/orders/${orderId}/send`).set(provider())
  }

  async function rowsFor(orderId: number) {
    const [order] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
    const lines = await ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
    return { order, lines }
  }

  describe('DELETE /api/orders/:id', () => {
    it('hard-deletes a draft and its lines', async () => {
      const orderId = await createDraft(ctx)

      const res = await remove(orderId)

      expect(res.status).toBe(204)
      expect(res.text).toBe('')
      expect(await rowsFor(orderId)).toEqual({ order: undefined, lines: [] })
      const after = await ctx.request
        .get(`/api/orders/${orderId}`)
        .set(provider())
      expect(after.status).toBe(404)
      const patients = await ctx.request.get('/api/patients').set(provider())
      const patient = patients.body.items.find(
        (p: { id: number }) => p.id === ctx.seed.patientId,
      )
      expect(patient).toMatchObject({ orderCount: 0, latestOrderStatus: null })
    })

    it('refuses anything but a draft with ORDER_NOT_DRAFT', async () => {
      const pending = await createSentOrder(ctx)
      const paid = await createSentOrder(ctx)
      await pay(ctx, paid)
      const cancelled = await createSentOrder(ctx)
      await cancel(cancelled)

      const results = await Promise.all(
        [pending, paid, cancelled].map((id) => remove(id)),
      )

      results.forEach((res) => {
        expect(res.status).toBe(409)
        expect(res.body.error.code).toBe('ORDER_NOT_DRAFT')
      })
      expect((await moneyState(ctx, paid)).ledger).toHaveLength(3)
    })

    it('is provider-only and owner-only', async () => {
      const orderId = await createDraft(ctx)

      const results = await Promise.all([
        remove(orderId, ctx.seed.patientUserId),
        remove(orderId, ctx.seed.otherProviderUserId),
        remove(999_999),
        ctx.request.delete('/api/orders/abc').set(provider()),
      ])

      expect(results.map((r) => r.status)).toEqual([403, 403, 404, 400])
      expect((await rowsFor(orderId)).order?.status).toBe('draft')
    })

    it('serializes with a concurrent send: exactly one wins', async () => {
      const ids = await Promise.all(
        Array.from({ length: 6 }, () => createDraft(ctx)),
      )

      const results = await Promise.all(
        ids.map(async (orderId) => {
          const [del, sent] = await Promise.all([
            remove(orderId),
            send(orderId),
          ])
          return { orderId, del: del.status, sent: sent.status }
        }),
      )

      await Promise.all(
        results.map(async ({ orderId, del, sent }) => {
          const { order } = await rowsFor(orderId)
          if (del === 204) {
            expect(sent).toBe(404)
            expect(order).toBeUndefined()
            return
          }
          expect([del, sent]).toEqual([409, 200])
          expect(order?.status).toBe('pending_payment')
        }),
      )
    })

    it('cannot race a payment: a draft is unpayable and a sent order undeletable', async () => {
      const draftId = await createDraft(ctx)
      const pendingId = await createSentOrder(ctx)

      const [delDraft, payDraft, delPending, payPending] = await Promise.all([
        remove(draftId),
        pay(ctx, draftId),
        remove(pendingId),
        pay(ctx, pendingId),
      ])

      expect([delDraft.status, payDraft.status]).toEqual([204, 404])
      expect([delPending.status, payPending.status]).toEqual([409, 200])
      expect((await moneyState(ctx, pendingId)).ledger).toHaveLength(3)
      expect(ctx.gateway.charges).toHaveLength(1)
    })
  })

  it('words every status conflict with human labels, never raw status values', async () => {
    const pending = await createSentOrder(ctx)
    const paid = await createSentOrder(ctx)
    await pay(ctx, paid)
    const draft = await createDraft(ctx)
    const cancelled = await createSentOrder(ctx)
    await cancel(cancelled)

    const cases = [
      [
        remove(pending),
        'This order is awaiting payment; only drafts can be deleted.',
      ],
      [send(paid), 'This order is paid; only drafts can be sent.'],
      [
        ctx.request
          .put(`/api/orders/${cancelled}/lines`)
          .set(provider())
          .send({ lines: [] }),
        'This order is cancelled; only drafts can be edited.',
      ],
      [
        reopen(draft),
        'This order is a draft; only cancelled orders can be reopened.',
      ],
      [
        cancel(paid),
        'This order is paid; only orders awaiting payment can be cancelled.',
      ],
      [
        cancel(draft),
        'This order is a draft; only orders awaiting payment can be cancelled.',
      ],
      [pay(ctx, cancelled), "This order is cancelled and can't be paid."],
    ] as const

    const results = await Promise.all(
      cases.map(async ([request, message]) => [
        (await request).body.error.message,
        message,
      ]),
    )

    results.forEach(([actual, expected]) => {
      expect(actual).toBe(expected)
      // Exact text above pins the wording; this catches any raw enum such as pending_payment.
      expect(actual).not.toContain('_')
    })
  })

  describe('POST /api/orders/:id/reopen', () => {
    it('turns a cancelled order back into a draft, keeping its lines', async () => {
      const orderId = await createSentOrder(ctx)
      await cancel(orderId)
      const linesBefore = (await rowsFor(orderId)).lines

      const res = await reopen(orderId)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        view: 'provider',
        status: 'draft',
        sentAt: null,
        paidAt: null,
        cancelledAt: null,
        payment: null,
        ledger: [],
      })
      // Priced live again, as for any draft.
      expect(res.body.split).not.toBeNull()
      expect(res.body.lines).toHaveLength(sampleLines(ctx).length)
      const { order, lines } = await rowsFor(orderId)
      expect(order).toMatchObject({
        subtotalCents: null,
        platformFeeCents: null,
        totalCents: null,
      })
      expect(lines).toEqual(linesBefore)
    })

    it('hides the reopened order from the patient until it is re-sent', async () => {
      const orderId = await createSentOrder(ctx)
      await cancel(orderId)
      await reopen(orderId)
      const patient = as(ctx.seed.patientUserId)

      const view = await ctx.request.get(`/api/orders/${orderId}`).set(patient)
      const list = await ctx.request.get('/api/orders').set(patient)
      const payRes = await pay(ctx, orderId)

      expect(view.status).toBe(404)
      expect(list.body).toEqual([])
      expect(payRes.status).toBe(404)
    })

    it('reopen, edit, re-send and pay writes a ledger for the new total', async () => {
      const orderId = await createSentOrder(ctx)
      await cancel(orderId)
      await reopen(orderId)
      const [a] = ctx.seed.products
      const edited = await ctx.request
        .put(`/api/orders/${orderId}/lines`)
        .set(provider())
        .send({
          lines: [{ productId: a!.id, quantity: 2, unitPriceCents: 4000 }],
        })
      expect(edited.status).toBe(200)

      const resent = await send(orderId)
      const paid = await pay(ctx, orderId)

      expect(resent.status).toBe(200)
      expect(resent.body).toMatchObject({
        status: 'pending_payment',
        cancelledAt: null,
      })
      expect(resent.body.split.totalCents).toBe(8000)
      expect(ctx.notifier.sent).toEqual([orderId, orderId])
      expect(paid.status).toBe(200)
      expect(paid.body).toMatchObject({ status: 'paid', totalCents: 8000 })
      const state = await moneyState(ctx, orderId)
      expect(state.payments.map((p) => p.amountCents)).toEqual([8000])
      expect(state.ledger.reduce((sum, e) => sum + e.amountCents, 0)).toBe(8000)
    })

    it('also reopens a draft cancelled before sending (a revision 6 row)', async () => {
      // The API no longer cancels drafts, but rows cancelled that way may exist.
      const orderId = await createDraft(ctx)
      await ctx.db
        .update(orders)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(orders.id, orderId))

      const res = await reopen(orderId)

      expect(res.status).toBe(200)
      expect(res.body.status).toBe('draft')
    })

    it('refuses anything but a cancelled order with ORDER_NOT_REOPENABLE', async () => {
      const draft = await createDraft(ctx)
      const pending = await createSentOrder(ctx)
      const paid = await createSentOrder(ctx)
      await pay(ctx, paid)

      const results = await Promise.all(
        [draft, pending, paid].map((id) => reopen(id)),
      )

      results.forEach((res) => {
        expect(res.status).toBe(409)
        expect(res.body.error.code).toBe('ORDER_NOT_REOPENABLE')
      })
    })

    it('is provider-only and owner-only', async () => {
      const orderId = await createSentOrder(ctx)
      await cancel(orderId)

      const results = await Promise.all([
        reopen(orderId, ctx.seed.patientUserId),
        reopen(orderId, ctx.seed.otherProviderUserId),
        reopen(999_999),
      ])

      expect(results.map((r) => r.status)).toEqual([403, 403, 404])
      expect((await rowsFor(orderId)).order?.status).toBe('cancelled')
    })
  })
})
