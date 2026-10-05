import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
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
      ctx.request
        .patch(`/api/products/${ctx.seed.products[0]!.id}/stock`)
        .set(patient)
        .send({ stockQuantity: 1 }),
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
    expect(JSON.stringify(sent.body)).not.toMatch(/cogs|margin|ledger/i)
  })

  it('scopes the patient list and order list to the acting provider', async () => {
    await createDraft(ctx)

    const mine = await ctx.request
      .get('/api/patients')
      .set(as(ctx.seed.providerUserId))
    const theirs = await ctx.request
      .get('/api/orders')
      .set(as(ctx.seed.otherProviderUserId))

    const ids = mine.body.map((p: { id: number }) => p.id)
    expect(ids).toContain(ctx.seed.patientId)
    expect(
      mine.body.find((p: { id: number }) => p.id === ctx.seed.patientId),
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

  it('rejects a price below COGS on the offending line', async () => {
    const orderId = await createDraft(ctx, [])
    const [a, b] = ctx.seed.products

    const res = await putLines(orderId, [
      { productId: a!.id, quantity: 1, unitPriceCents: a!.cogsCents },
      { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents - 1 },
    ])

    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({
      code: 'PRICE_BELOW_COGS',
      field: 'lines.1.unitPriceCents',
    })
  })

  it('rejects duplicate products, unknown products and quantities above stock', async () => {
    const orderId = await createDraft(ctx, [])
    const p = ctx.seed.products[0]!
    const line = { productId: p.id, quantity: 1, unitPriceCents: p.cogsCents }

    const dup = await putLines(orderId, [line, line])
    const unknown = await putLines(orderId, [{ ...line, productId: 9999 }])
    const tooMany = await putLines(orderId, [
      { ...line, quantity: p.stockQuantity + 1 },
    ])

    expect(dup.body.error).toMatchObject({
      code: 'DUPLICATE_PRODUCT',
      field: 'lines.1.productId',
    })
    expect(unknown.body.error).toMatchObject({
      code: 'UNKNOWN_PRODUCT',
      field: 'lines.0.productId',
    })
    expect(tooMany.body.error).toMatchObject({
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
    expect(empty.body.error).toMatchObject({
      code: 'EMPTY_ORDER',
      field: 'lines',
    })
    expect(edit.status).toBe(409)
    expect(resend.body.error.code).toBe('ORDER_NOT_DRAFT')
  })

  it('rejects negative stock and bad ids', async () => {
    const provider = as(ctx.seed.providerUserId)

    const negative = await ctx.request
      .patch(`/api/products/${ctx.seed.products[0]!.id}/stock`)
      .set(provider)
      .send({ stockQuantity: -1 })
    const badId = await ctx.request.get('/api/orders/abc').set(provider)
    const missing = await ctx.request.get('/api/orders/999999').set(provider)

    expect(negative.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'stockQuantity',
    })
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
