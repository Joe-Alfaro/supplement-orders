import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  as,
  createDraft,
  createSentOrder,
  moneyState,
  pay,
} from '../testing/flows'

/** A promise plus the function that resolves it. */
function deferred() {
  const handle: { resolve: () => void } = { resolve: () => {} }
  const promise = new Promise<void>((resolve) => {
    handle.resolve = resolve
  })
  return { promise, resolve: () => handle.resolve() }
}

describe('POST /api/orders/:id/cancel', () => {
  let ctx: InternalTestContext

  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx.close()
  })

  function cancel(orderId: number, userId = ctx.seed.providerUserId) {
    return ctx.request.post(`/api/orders/${orderId}/cancel`).set(as(userId))
  }

  function patientView(orderId: number) {
    return ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.patientUserId))
  }

  it('cancels a pending order without touching money or stock', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)

    const res = await cancel(orderId)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ view: 'provider', status: 'cancelled' })
    expect(Date.parse(res.body.cancelledAt)).not.toBeNaN()
    expect(res.body.paidAt).toBeNull()
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toEqual([])
    expect(after.ledger).toEqual([])
    expect(after.stock).toEqual(before.stock)
    expect(ctx.notifier.cancelled).toEqual([orderId])
  })

  it('shows the patient a cancelled order they cannot pay', async () => {
    const orderId = await createSentOrder(ctx)
    await cancel(orderId)

    const view = await patientView(orderId)
    const list = await ctx.request
      .get('/api/orders')
      .set(as(ctx.seed.patientUserId))
    const payRes = await pay(ctx, orderId)

    expect(view.status).toBe(200)
    expect(view.body).toMatchObject({ status: 'cancelled', view: 'patient' })
    expect(view.body.cancelledAt).not.toBeNull()
    expect(list.body.map((o: { id: number }) => o.id)).toEqual([orderId])
    expect(payRes.status).toBe(409)
    expect(payRes.body.error.code).toBe('ORDER_NOT_PAYABLE')
    expect(ctx.gateway.charges).toEqual([])
  })

  it('cancels a draft silently and keeps it hidden from the patient', async () => {
    const orderId = await createDraft(ctx)

    const res = await cancel(orderId)
    const view = await patientView(orderId)
    const list = await ctx.request
      .get('/api/orders')
      .set(as(ctx.seed.patientUserId))
    const payRes = await pay(ctx, orderId)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'cancelled', sentAt: null })
    expect(ctx.notifier.cancelled).toEqual([])
    expect(view.status).toBe(404)
    expect(list.body).toEqual([])
    expect(payRes.status).toBe(404)
  })

  it('refuses to cancel a paid or already-cancelled order', async () => {
    const paidId = await createSentOrder(ctx)
    await pay(ctx, paidId)
    const cancelledId = await createSentOrder(ctx)
    await cancel(cancelledId)
    const paidBefore = await moneyState(ctx, paidId)

    const [paid, again] = await Promise.all([
      cancel(paidId),
      cancel(cancelledId),
    ])

    ;[paid, again].forEach((res) => {
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE')
    })
    expect(await moneyState(ctx, paidId)).toEqual(paidBefore)
  })

  it('is provider-only and owner-only', async () => {
    const orderId = await createSentOrder(ctx)

    const results = await Promise.all([
      cancel(orderId, ctx.seed.patientUserId),
      cancel(orderId, ctx.seed.otherProviderUserId),
      cancel(999_999),
      ctx.request
        .post('/api/orders/abc/cancel')
        .set(as(ctx.seed.providerUserId)),
      ctx.request.post(`/api/orders/${orderId}/cancel`),
    ])

    expect(results.map((r) => r.status)).toEqual([403, 403, 404, 400, 401])
    expect((await patientView(orderId)).body.status).toBe('pending_payment')
  })

  it('a cancel arriving mid-payment waits for the row lock and loses', async () => {
    const orderId = await createSentOrder(ctx)
    const charge = ctx.gateway.charge.bind(ctx.gateway)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(ctx.gateway, 'charge').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return charge(...args)
    })

    const paying = pay(ctx, orderId).then((r) => r)
    await entered.promise
    const cancelling = cancel(orderId).then((r) => r)
    // Give the cancel time to block on the lock the pay transaction holds.
    await new Promise((resolve) => setTimeout(resolve, 150))
    release.resolve()
    const [payRes, cancelRes] = await Promise.all([paying, cancelling])

    expect(payRes.status).toBe(200)
    expect(cancelRes.status).toBe(409)
    expect(cancelRes.body.error.code).toBe('ORDER_NOT_CANCELLABLE')
    const state = await moneyState(ctx, orderId)
    expect(state.order?.status).toBe('paid')
    expect(state.payments).toHaveLength(1)
    expect(state.ledger).toHaveLength(3)
    expect(ctx.notifier.cancelled).toEqual([])
  })

  it('a pay after a committed cancel is refused and charges nothing', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)

    expect((await cancel(orderId)).status).toBe(200)
    const payRes = await pay(ctx, orderId)

    expect(payRes.status).toBe(409)
    expect(ctx.gateway.charges).toEqual([])
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toEqual([])
    expect(after.stock).toEqual(before.stock)
  })

  it('races cancel and pay concurrently: exactly one wins, every time', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const orderId = await createSentOrder(ctx, [
          {
            productId: ctx.seed.products[0]!.id,
            quantity: 1,
            unitPriceCents: 2000,
          },
        ])
        return orderId
      }),
    ).then((ids) =>
      Promise.all(
        ids.map(async (orderId) => {
          const [payRes, cancelRes] = await Promise.all([
            pay(ctx, orderId),
            cancel(orderId),
          ])
          return { orderId, pay: payRes.status, cancel: cancelRes.status }
        }),
      ),
    )

    await Promise.all(
      results.map(async (r) => {
        expect([r.pay, r.cancel].sort()).toEqual([200, 409])
        const state = await moneyState(ctx, r.orderId)
        if (r.pay === 200) {
          expect(state.order?.status).toBe('paid')
          expect(state.payments).toHaveLength(1)
          expect(state.ledger).toHaveLength(3)
          return
        }
        expect(state.order?.status).toBe('cancelled')
        expect(state.payments).toEqual([])
        expect(state.ledger).toEqual([])
      }),
    )
    // Stock moved by exactly the paid orders' quantities.
    const paidCount = results.filter((r) => r.pay === 200).length
    const [stock] = (await moneyState(ctx, results[0]!.orderId)).stock
    expect(stock!.stockQuantity).toBe(
      ctx.seed.products[0]!.stockQuantity - paidCount,
    )
  })
})
