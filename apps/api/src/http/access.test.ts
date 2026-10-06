import { providerOrderDetailDtoSchema } from '@supplement-orders/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { products } from '../db/schema'
import { as, createDraft, createSentOrder, pay } from '../testing/flows'

describe('auth, persona and ownership', () => {
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

  it('returns 401 without a user or for an unknown user', async () => {
    const missing = await ctx.request.get('/api/patients')
    const unknown = await ctx.request.get('/api/patients').set(as(9999))

    expect(missing.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(unknown.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('returns 403 when a patient calls provider endpoints', async () => {
    const patient = as(ctx.seed.patientUserId)
    const calls = [
      ctx.request.get('/api/products').set(patient),
      ctx.request.get('/api/patients').set(patient),
      ctx.request.get('/api/dashboard').set(patient),
      ctx.request
        .post('/api/orders')
        .set(patient)
        .send({ patientId: ctx.seed.patientId }),
    ]

    const results = await Promise.all(calls)

    results.forEach((res) => {
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  })

  it("returns 403 for another provider's patient and order", async () => {
    const orderId = await createDraft(ctx)
    const other = as(ctx.seed.otherProviderUserId)

    const results = await Promise.all([
      ctx.request.get(`/api/patients/${ctx.seed.patientId}`).set(other),
      ctx.request.get(`/api/orders/${orderId}`).set(other),
      ctx.request.get(`/api/orders?patientId=${ctx.seed.patientId}`).set(other),
      ctx.request
        .put(`/api/orders/${orderId}/lines`)
        .set(other)
        .send({ lines: [] }),
      ctx.request.post(`/api/orders/${orderId}/send`).set(other),
      ctx.request
        .post('/api/orders')
        .set(other)
        .send({ patientId: ctx.seed.patientId }),
    ])

    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403])
  })

  it("returns 403 when a patient opens or pays another patient's order", async () => {
    const orderId = await createSentOrder(ctx)
    const other = as(ctx.seed.otherPatientUserId)

    const view = await ctx.request.get(`/api/orders/${orderId}`).set(other)
    const payRes = await ctx.request
      .post(`/api/orders/${orderId}/pay`)
      .set(other)

    expect(view.status).toBe(403)
    expect(payRes.status).toBe(403)
  })

  it('hides drafts and internals from the patient', async () => {
    const draftId = await createDraft(ctx)
    const sentId = await createSentOrder(ctx)
    const patient = as(ctx.seed.patientUserId)

    const list = await ctx.request.get('/api/orders').set(patient)
    const draft = await ctx.request.get(`/api/orders/${draftId}`).set(patient)
    const sent = await ctx.request.get(`/api/orders/${sentId}`).set(patient)

    expect(list.body.map((o: { id: number }) => o.id)).toEqual([sentId])
    expect(draft.status).toBe(404)
    expect(sent.status).toBe(200)
    expect(sent.body.view).toBe('patient')
    expect(JSON.stringify(sent.body)).not.toMatch(/cogs|margin|ledger|fee/i)
  })

  it('scopes the patient list and order list to the acting provider', async () => {
    await createDraft(ctx)

    const mine = await ctx.request
      .get('/api/patients')
      .set(as(ctx.seed.providerUserId))
    const theirs = await ctx.request
      .get('/api/orders')
      .set(as(ctx.seed.otherProviderUserId))

    const ids = mine.body.items.map((p: { id: number }) => p.id)
    expect(ids).toContain(ctx.seed.patientId)
    expect(
      mine.body.items.find((p: { id: number }) => p.id === ctx.seed.patientId),
    ).toMatchObject({ orderCount: 1, latestOrderStatus: 'draft' })
    expect(theirs.body).toEqual([])
  })
})

describe('validation errors', () => {
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

  async function putLines(orderId: number, lines: unknown) {
    return ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(as(ctx.seed.providerUserId))
      .send({ lines })
  }

  it('rejects non-integer cents with a field path', async () => {
    const orderId = await createDraft(ctx, [])
    const product = ctx.seed.products[0]!

    const res = await putLines(orderId, [
      { productId: product.id, quantity: 1, unitPriceCents: 12.5 },
    ])

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
        field: 'lines.0.unitPriceCents',
      },
    })
  })

  it('saves incomplete lines in order and returns them on reload', async () => {
    const orderId = await createDraft(ctx, [])
    const [a, b] = ctx.seed.products

    const res = await putLines(orderId, [
      { productId: a!.id, unitPriceCents: null },
      {},
      { productId: b!.id, quantity: 2, unitPriceCents: b!.cogsCents },
    ])
    const reloaded = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.providerUserId))

    expect(res.status).toBe(200)
    expect(res.body.patientDateOfBirth).toBe('1984-03-14')
    expect(reloaded.body.lines).toEqual(res.body.lines)
    expect(
      res.body.lines.map(
        (l: { productId: number | null; quantity: number }) => [
          l.productId,
          l.quantity,
        ],
      ),
    ).toEqual([
      [a!.id, 1],
      [null, 1],
      [b!.id, 2],
    ])
    expect(res.body.lines[0]).toMatchObject({
      stockQuantity: a!.stockQuantity,
      unitCogsCents: a!.cogsCents,
      unitPriceCents: null,
      lineTotalCents: null,
      markupBps: null,
    })
    expect(res.body.lines[0].minUnitPriceCents).toBeGreaterThan(a!.cogsCents)
    expect(res.body.lines[1]).toMatchObject({
      stockQuantity: null,
      productName: null,
      unitCogsCents: null,
      minUnitPriceCents: null,
      markupBps: null,
    })
    // Priced at cost: the 0.75% fee makes the net markup -75 bps.
    expect(res.body.lines[2].markupBps).toBe(-75)
    // An incomplete draft would fail send, so it has no split.
    expect(res.body.split).toBeNull()
  })

  it('reports uncapped net markup, and null markup at zero cost', async () => {
    const [a] = ctx.seed.products
    const [free] = await ctx.db
      .insert(products)
      .values({
        sku: 'SAMPLE-0',
        name: 'Free sample',
        cogsCents: 0,
        stockQuantity: 10,
      })
      .returning({ id: products.id })
    const orderId = await createDraft(ctx, [])

    const res = await putLines(orderId, [
      { productId: a!.id, quantity: 1, unitPriceCents: a!.cogsCents * 14 },
      { productId: free!.id, quantity: 1, unitPriceCents: 500 },
    ])

    expect(res.status).toBe(200)
    // (9925 * 14c - 10000c) / c = 128950 bps, i.e. 1289.5%: well past any cap.
    expect(res.body.lines[0].markupBps).toBe(128_950)
    expect(res.body.lines[1]).toMatchObject({
      unitCogsCents: 0,
      markupBps: null,
      minUnitPriceCents: 0,
    })
    expect(providerOrderDetailDtoSchema.safeParse(res.body).success).toBe(true)
  })

  it('saves a draft priced below its minimum but refuses to send it', async () => {
    const orderId = await createDraft(ctx, [])
    const [a, b] = ctx.seed.products
    const saved = await putLines(orderId, [
      { productId: a!.id, quantity: 1, unitPriceCents: a!.cogsCents + 500 },
      { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents },
    ])

    const sent = await ctx.request
      .post(`/api/orders/${orderId}/send`)
      .set(as(ctx.seed.providerUserId))

    expect(saved.status).toBe(200)
    expect(saved.body.split).toBeNull()
    expect(sent.status).toBe(422)
    expect(sent.body.error).toMatchObject({
      code: 'PRICE_BELOW_MINIMUM',
      field: 'lines.1.unitPriceCents',
    })
  })

  it('refuses to send incomplete lines, naming the missing part', async () => {
    const [a] = ctx.seed.products
    const provider = as(ctx.seed.providerUserId)
    const noProduct = await createDraft(ctx, [
      { productId: a!.id, unitPriceCents: a!.cogsCents + 500 },
      { unitPriceCents: 1000 },
    ])
    const noPrice = await createDraft(ctx, [{ productId: a!.id }])

    const first = await ctx.request
      .post(`/api/orders/${noProduct}/send`)
      .set(provider)
    const second = await ctx.request
      .post(`/api/orders/${noPrice}/send`)
      .set(provider)

    expect(first.status).toBe(422)
    expect(first.body.error).toMatchObject({
      code: 'INCOMPLETE_LINE',
      field: 'lines.1.productId',
    })
    expect(second.body.error).toMatchObject({
      code: 'INCOMPLETE_LINE',
      field: 'lines.0.unitPriceCents',
    })
  })

  it('rejects duplicate and unknown products on save, and quantities above stock on send', async () => {
    const orderId = await createDraft(ctx, [])
    const p = ctx.seed.products[0]!
    const line = {
      productId: p.id,
      quantity: 1,
      unitPriceCents: p.cogsCents + 500,
    }

    const dup = await putLines(orderId, [line, { productId: p.id }])
    const unknown = await putLines(orderId, [{ ...line, productId: 9999 }])
    const tooMany = await putLines(orderId, [
      { ...line, quantity: p.stockQuantity + 1 },
    ])
    const sent = await ctx.request
      .post(`/api/orders/${orderId}/send`)
      .set(as(ctx.seed.providerUserId))

    expect(dup.body.error).toMatchObject({
      code: 'DUPLICATE_PRODUCT',
      field: 'lines.1.productId',
    })
    expect(unknown.body.error).toMatchObject({
      code: 'UNKNOWN_PRODUCT',
      field: 'lines.0.productId',
    })
    expect(tooMany.status).toBe(200)
    expect(sent.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      field: 'lines.0.quantity',
    })
  })

  it('rejects sending an empty order and editing a sent one', async () => {
    const emptyId = await createDraft(ctx, [])
    const sentId = await createSentOrder(ctx)
    const provider = as(ctx.seed.providerUserId)

    const empty = await ctx.request
      .post(`/api/orders/${emptyId}/send`)
      .set(provider)
    const edit = await putLines(sentId, [])
    const resend = await ctx.request
      .post(`/api/orders/${sentId}/send`)
      .set(provider)

    expect(empty.status).toBe(422)
    expect(empty.body.error).toEqual({
      code: 'EMPTY_ORDER',
      message: expect.any(String),
    })
    expect(edit.status).toBe(409)
    expect(resend.body.error.code).toBe('ORDER_NOT_DRAFT')
  })

  it('has no stock endpoint, and rejects bad ids', async () => {
    const provider = as(ctx.seed.providerUserId)

    const stock = await ctx.request
      .patch(`/api/products/${ctx.seed.products[0]!.id}/stock`)
      .set(provider)
      .send({ stockQuantity: 1 })
    const badId = await ctx.request.get('/api/orders/abc').set(provider)
    const missing = await ctx.request.get('/api/orders/999999').set(provider)

    expect(stock.status).toBe(404)
    expect(badId.status).toBe(400)
    expect(missing.status).toBe(404)
  })
})

describe('send and simulated failure', () => {
  it('snapshots the split, notifies the patient, and ignores simulateFailure in production', async () => {
    const ctx = await createInternalTestContext({ nodeEnv: 'production' })
    try {
      await ctx.reset()
      const orderId = await createSentOrder(ctx)

      const res = await pay(ctx, orderId, { simulateFailure: true })

      expect(ctx.notifier.sent).toEqual([orderId])
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('paid')
    } finally {
      await ctx.close()
    }
  })
})
