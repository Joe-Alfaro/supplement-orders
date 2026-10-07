import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { as, createDraft, createSentOrder } from '../testing/flows'
import { createTestContext, type TestContext } from '../testing/harness'

// Black-box revision 14: inventory is changed through the admin API.
// Unspecified quote envelope chosen here: error.partialPaymentQuote and
// detail.partialPaymentQuote, each containing { pay, backorder } totals.
describe('revision 14 availability HTTP contract', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await createTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx?.close()
  })
  function lines() {
    return ctx.seed.products.slice(0, 2).map((p) => ({
      productId: p.id,
      quantity: 3,
      unitPriceCents: p.cogsCents + 1000,
    }))
  }
  async function stock(productId: number, quantity: number, expected: number) {
    const result = await ctx.request
      .put(`/api/admin/products/${productId}/stock`)
      .set(as(ctx.seed.adminUserId))
      .send({ stockQuantity: quantity, expectedStockQuantity: expected })
    expect(result.status).toBe(200)
  }
  async function fixture(quantities = [0, 0]) {
    const input = lines()
    const id = await createSentOrder(ctx, input)
    await Promise.all(
      input.map((line, index) =>
        stock(
          line.productId,
          quantities[index]!,
          ctx.seed.products[index]!.stockQuantity,
        ),
      ),
    )
    return { id, input }
  }
  function detail(id: number, user = ctx.seed.patientUserId) {
    return ctx.request.get(`/api/orders/${id}`).set(as(user))
  }
  function pay(id: number, body: object, user = ctx.seed.patientUserId) {
    return ctx.request.post(`/api/orders/${id}/pay`).set(as(user)).send(body)
  }

  it('derives awaiting_stock in detail, provider lists, patient My orders and status filters', async () => {
    const { id, input } = await fixture()
    const views = await Promise.allSettled(
      [ctx.seed.providerUserId, ctx.seed.patientUserId].map(async (user) => {
        const order = await detail(id, user)
        expect(order.status).toBe(200)
        expect(order.body.status).toBe('awaiting_stock')
        const list = await ctx.request.get('/api/orders').set(as(user))
        expect(list.status).toBe(200)
        expect(list.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id, status: 'awaiting_stock' }),
          ]),
        )
      }),
    )
    views.forEach((view) => {
      if (view.status === 'rejected') throw view.reason
    })
    const awaiting = await ctx.request
      .get('/api/orders?status=awaiting_stock')
      .set(as(ctx.seed.providerUserId))
    expect(awaiting.status).toBe(200)
    expect(awaiting.body).toMatchObject({
      total: 1,
      items: [{ id, status: 'awaiting_stock' }],
    })
    const pending = await ctx.request
      .get('/api/orders?status=pending_payment')
      .set(as(ctx.seed.providerUserId))
    expect(pending.body.total).toBe(0)
    const patients = await ctx.request
      .get('/api/patients?latestStatus=awaiting_stock')
      .set(as(ctx.seed.providerUserId))
    expect(patients.status).toBe(200)
    expect(patients.body).toMatchObject({
      total: 1,
      items: [{ id: ctx.seed.patientId, latestOrderStatus: 'awaiting_stock' }],
    })
    await stock(input[0]!.productId, 8, 0)
    const restocked = await detail(id)
    expect(restocked.body.status).toBe('pending_payment')
    expect(restocked.body.lines[0]).toMatchObject({
      availableQuantity: 8,
      payableQuantity: 3,
      shortQuantity: 0,
    })
    const noLongerAwaiting = await ctx.request
      .get('/api/orders?status=awaiting_stock')
      .set(as(ctx.seed.providerUserId))
    expect(noLongerAwaiting.body.total).toBe(0)
    const latest = await ctx.request
      .get('/api/patients?latestStatus=pending_payment')
      .set(as(ctx.seed.providerUserId))
    expect(latest.body.total).toBe(1)
  })

  it.each([undefined, 'full'])(
    'returns full-pay shortfall availability and current quote for mode %s',
    async (mode) => {
      const { id, input } = await fixture([1, 0])
      const before = await detail(id)
      const response = await pay(id, {
        mode,
        expectedRevision: before.body.revision,
        expectedTotalCents: before.body.totalCents,
      })
      expect(response.status).toBe(409)
      expect(response.body.error).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        availability: input.map((line, index) => ({
          lineId: expect.any(Number),
          productId: line.productId,
          quantity: 3,
          availableQuantity: [1, 0][index],
        })),
        partialPaymentQuote: {
          pay: { totalCents: input[0]!.unitPriceCents },
          backorder: {
            totalCents:
              2 * input[0]!.unitPriceCents + 3 * input[1]!.unitPriceCents,
          },
        },
      })
      expect((await detail(id)).body).toEqual(before.body)
      const list = await ctx.request
        .get('/api/orders')
        .set(as(ctx.seed.patientUserId))
      expect(list.body).toHaveLength(1)
      expect(before.body.payment).toBeNull()
    },
  )

  it('returns AWAITING_STOCK before stale-quote checks when nothing is payable', async () => {
    const { id } = await fixture()
    const before = await detail(id)
    const response = await pay(id, {
      mode: 'available',
      expectedRevision: 999,
      expectedTotalCents: 1,
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('AWAITING_STOCK')
    expect((await detail(id)).body).toEqual(before.body)
    const list = await ctx.request
      .get('/api/orders')
      .set(as(ctx.seed.patientUserId))
    expect(list.body).toHaveLength(1)
  })

  it('exposes the reduced quote and uncapped availability the patient consents to', async () => {
    const { id, input } = await fixture([1, 8])
    const response = await detail(id)
    expect(response.status).toBe(200)
    const total = input[0]!.unitPriceCents + 3 * input[1]!.unitPriceCents
    expect(response.body.partialPaymentQuote).toMatchObject({
      pay: {
        subtotalCents: total,
        totalCents: total,
        platformFeeCents: Math.ceil((total * 75) / 10000),
      },
      backorder: { totalCents: 2 * input[0]!.unitPriceCents },
    })
    expect(response.body.lines).toMatchObject([
      { availableQuantity: 1, payableQuantity: 1, shortQuantity: 2 },
      { availableQuantity: 8, payableQuantity: 3, shortQuantity: 0 },
    ])
  })

  it('pays available mode without a split when all units are available', async () => {
    const id = await createSentOrder(ctx, lines())
    const before = await detail(id)
    const response = await pay(id, {
      mode: 'available',
      expectedRevision: before.body.revision,
      expectedTotalCents: before.body.totalCents,
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      status: 'paid',
      backorderOrderId: null,
      revision: before.body.revision,
      totalCents: before.body.totalCents,
    })
    expect(
      (await ctx.request.get('/api/orders').set(as(ctx.seed.patientUserId)))
        .body,
    ).toHaveLength(1)
  })

  it('saves overstock drafts, warns on send, then sends with acknowledgement without reserving stock', async () => {
    const input = lines()
    await stock(input[0]!.productId, 1, ctx.seed.products[0]!.stockQuantity)
    const id = await createDraft(ctx, input)
    const draft = await detail(id, ctx.seed.providerUserId)
    expect(draft.body.lines[0].availableQuantity).toBe(1)
    const send = (acknowledgeLowStock?: boolean) =>
      ctx.request
        .post(`/api/orders/${id}/send`)
        .set(as(ctx.seed.providerUserId))
        .send({ acknowledgeLowStock })
    const warning = await send()
    expect(warning.status).toBe(409)
    expect(warning.body.error).toMatchObject({
      code: 'LOW_STOCK_UNACKNOWLEDGED',
      lines: [
        {
          lineId: expect.any(Number),
          productId: input[0]!.productId,
          productName: expect.any(String),
          quantity: 3,
          availableQuantity: 1,
        },
      ],
    })
    expect((await detail(id, ctx.seed.providerUserId)).body.status).toBe(
      'draft',
    )
    expect((await send(false)).status).toBe(409)
    const sent = await send(true)
    expect(sent.status).toBe(200)
    expect(sent.body.status).toBe('pending_payment')
    expect(sent.body.lines[0].availableQuantity).toBe(1)
    // A CAS expecting the original stock also proves send did not reserve it.
    await stock(input[0]!.productId, 2, 1)
  })

  it.each([
    'otherPatientUserId',
    'providerUserId',
    'otherProviderUserId',
  ] as const)(
    'forbids available-pay by %s without changing the order',
    async (actor) => {
      const { id, input } = await fixture([1, 0])
      const before = await detail(id)
      const response = await pay(
        id,
        {
          mode: 'available',
          expectedRevision: before.body.revision,
          expectedTotalCents: input[0]!.unitPriceCents,
        },
        ctx.seed[actor],
      )
      expect(response.status).toBe(403)
      expect((await detail(id)).body).toEqual(before.body)
      expect(
        (await ctx.request.get('/api/orders').set(as(ctx.seed.patientUserId)))
          .body,
      ).toHaveLength(1)
    },
  )
})
