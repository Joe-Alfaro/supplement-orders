import {
  minUnitPriceCents,
  productDtoSchema,
  productPageDtoSchema,
} from '@supplement-orders/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { providerProductPrices, providers, products, users } from '../db/schema'
import { as } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 20: every provider has a default patient price for every product,
// starting at the minimum. Provider-only; never in a patient DTO.

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

function product(index = 0) {
  return ctx.seed.products[index]!
}

function minOf(index = 0) {
  return minUnitPriceCents(product(index).cogsCents)
}

function setDefault(productId: number, body: unknown, userId?: number) {
  return ctx.request
    .put(`/api/products/${productId}/default-price`)
    .set(as(userId ?? ctx.seed.providerUserId))
    .send(body as object)
}

function reset(productId: number, userId?: number) {
  return ctx.request
    .post(`/api/products/${productId}/default-price/reset`)
    .set(as(userId ?? ctx.seed.providerUserId))
}

async function listFor(userId: number, q = '') {
  const res = await ctx.request
    .get(`/api/products${q}`)
    .set(as(userId))
    .query({ limit: 100 })
  expect(res.status).toBe(200)
  return productPageDtoSchema.parse(res.body).items
}

async function defaultOf(userId: number, productId: number) {
  const row = (await listFor(userId)).find((p) => p.id === productId)
  return row!.defaultUnitPriceCents
}

describe('defaults exist from the start', () => {
  it('has a row at the minimum for every provider and product', async () => {
    const rows = await ctx.db.select().from(providerProductPrices)
    const providerCount = (await ctx.db.select().from(providers)).length
    expect(rows).toHaveLength(providerCount * ctx.seed.products.length)
    rows.forEach((row) => {
      const cogs = ctx.seed.products.find(
        (p) => p.id === row.productId,
      )!.cogsCents
      expect(row.unitPriceCents).toBe(minUnitPriceCents(cogs))
    })
  })

  it('shows the minimum as defaultUnitPriceCents in the product list', async () => {
    const items = await listFor(ctx.seed.providerUserId)
    expect(items).toHaveLength(ctx.seed.products.length)
    items.forEach((item) => {
      expect(item.defaultUnitPriceCents).toBe(minUnitPriceCents(item.cogsCents))
    })
  })

  it('includes the default in search results too', async () => {
    const res = await ctx.request
      .get('/api/products')
      .set(as(ctx.seed.providerUserId))
      .query({ q: 'vitamin' })
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].defaultUnitPriceCents).toBe(minOf(0))
  })

  it('gives a newly created provider a default for every product', async () => {
    const [user] = await ctx.db
      .insert(users)
      .values({ name: 'Dr. New', role: 'provider' })
      .returning()
    const [provider] = await ctx.db
      .insert(providers)
      .values({ userId: user!.id })
      .returning()

    const rows = await ctx.db
      .select()
      .from(providerProductPrices)
      .where(eq(providerProductPrices.providerId, provider!.id))
    expect(rows).toHaveLength(ctx.seed.products.length)
    expect(
      (await listFor(user!.id)).map((p) => p.defaultUnitPriceCents),
    ).toEqual(
      (await listFor(ctx.seed.providerUserId)).map(
        (p) => p.defaultUnitPriceCents,
      ),
    )
  })

  it('gives a newly created product a default for every provider', async () => {
    const [created] = await ctx.db
      .insert(products)
      .values({
        sku: 'NEW-1',
        name: 'Aardvark',
        cogsCents: 1000,
        stockQuantity: 5,
      })
      .returning()

    const rows = await ctx.db
      .select()
      .from(providerProductPrices)
      .where(eq(providerProductPrices.productId, created!.id))
    expect(rows).toHaveLength((await ctx.db.select().from(providers)).length)
    rows.forEach((row) => {
      expect(row.unitPriceCents).toBe(minUnitPriceCents(1000))
    })
    expect(await defaultOf(ctx.seed.providerUserId, created!.id)).toBe(
      minUnitPriceCents(1000),
    )
  })
})

describe('PUT /api/products/:id/default-price', () => {
  it('sets the default and returns the product row', async () => {
    const res = await setDefault(product().id, { unitPriceCents: 2000 })
    expect(res.status).toBe(200)
    const row = productDtoSchema.parse(res.body)
    expect(row).toMatchObject({
      id: product().id,
      cogsCents: product().cogsCents,
      stockQuantity: product().stockQuantity,
      defaultUnitPriceCents: 2000,
    })
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(2000)
  })

  it('accepts exactly the minimum and exactly 1,000,000', async () => {
    expect(
      (await setDefault(product().id, { unitPriceCents: minOf() })).status,
    ).toBe(200)
    expect(
      (await setDefault(product().id, { unitPriceCents: 1_000_000 })).status,
    ).toBe(200)
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(
      1_000_000,
    )
  })

  it('is per provider: another provider keeps its own default', async () => {
    await setDefault(product().id, { unitPriceCents: 2000 })
    expect(await defaultOf(ctx.seed.otherProviderUserId, product().id)).toBe(
      minOf(),
    )
    await setDefault(
      product().id,
      { unitPriceCents: 3000 },
      ctx.seed.otherProviderUserId,
    )
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(2000)
    expect(await defaultOf(ctx.seed.otherProviderUserId, product().id)).toBe(
      3000,
    )
  })

  it('leaves other products alone', async () => {
    await setDefault(product(0).id, { unitPriceCents: 2000 })
    expect(await defaultOf(ctx.seed.providerUserId, product(1).id)).toBe(
      minOf(1),
    )
  })

  it('rejects a price below the minimum, naming it in the message', async () => {
    const res = await setDefault(product().id, { unitPriceCents: minOf() - 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'unitPriceCents',
    })
    expect(res.body.error.message).toContain(String(minOf()))
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(minOf())
  })

  it.each([
    ['a non-integer', { unitPriceCents: 2000.5 }],
    ['above the bound', { unitPriceCents: 1_000_001 }],
    ['zero', { unitPriceCents: 0 }],
    ['a string', { unitPriceCents: '2000' }],
    ['missing', {}],
  ])('rejects %s with 400 on unitPriceCents', async (_label, body) => {
    const res = await setDefault(product().id, body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'unitPriceCents',
    })
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(minOf())
  })

  it('answers 404 for an unknown product and 400 for a bad id', async () => {
    const missing = await setDefault(9999, { unitPriceCents: 2000 })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('NOT_FOUND')
    expect(
      (await setDefault('abc' as never, { unitPriceCents: 2000 })).status,
    ).toBe(400)
  })

  it('answers 403 to a patient and an admin, and 401 to nobody', async () => {
    const asPatient = await setDefault(
      product().id,
      { unitPriceCents: 2000 },
      ctx.seed.patientUserId,
    )
    const asAdmin = await setDefault(
      product().id,
      { unitPriceCents: 2000 },
      ctx.seed.adminUserId,
    )
    expect(asPatient.status).toBe(403)
    expect(asAdmin.status).toBe(403)
    expect(
      (
        await ctx.request
          .put(`/api/products/${product().id}/default-price`)
          .send({ unitPriceCents: 2000 })
      ).status,
    ).toBe(401)
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(minOf())
  })

  it('checks the persona before the product exists', async () => {
    const res = await setDefault(
      9999,
      { unitPriceCents: 2000 },
      ctx.seed.patientUserId,
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /api/products/:id/default-price/reset', () => {
  it('sets the default back to the minimum and returns the row', async () => {
    await setDefault(product().id, { unitPriceCents: 2000 })
    const res = await reset(product().id)
    expect(res.status).toBe(200)
    expect(productDtoSchema.parse(res.body).defaultUnitPriceCents).toBe(minOf())
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(minOf())
  })

  it('resets only the calling provider', async () => {
    await setDefault(product().id, { unitPriceCents: 2000 })
    await setDefault(
      product().id,
      { unitPriceCents: 3000 },
      ctx.seed.otherProviderUserId,
    )
    await reset(product().id)
    expect(await defaultOf(ctx.seed.otherProviderUserId, product().id)).toBe(
      3000,
    )
  })

  it('answers 404, 403 like set', async () => {
    expect((await reset(9999)).status).toBe(404)
    expect((await reset(product().id, ctx.seed.patientUserId)).status).toBe(403)
    expect((await reset(product().id, ctx.seed.adminUserId)).status).toBe(403)
  })
})

describe('defaults and orders', () => {
  it('never put a default in a patient DTO', async () => {
    await setDefault(product().id, { unitPriceCents: 2000 })
    const created = await ctx.request
      .post('/api/orders')
      .set(as(ctx.seed.providerUserId))
      .send({ patientId: ctx.seed.patientId })
    const orderId: number = created.body.id
    await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(as(ctx.seed.providerUserId))
      .send({
        lines: [{ productId: product().id, quantity: 1, unitPriceCents: 2500 }],
      })
    await ctx.request
      .post(`/api/orders/${orderId}/send`)
      .set(as(ctx.seed.providerUserId))

    const bodies = await Promise.all([
      ctx.request.get(`/api/orders/${orderId}`).set(as(ctx.seed.patientUserId)),
      ctx.request.get('/api/orders').set(as(ctx.seed.patientUserId)),
      ctx.request.get('/api/users/me').set(as(ctx.seed.patientUserId)),
      ctx.request.get('/api/products').set(as(ctx.seed.patientUserId)),
    ])
    bodies.slice(0, 3).forEach((res) => {
      expect(JSON.stringify(res.body)).not.toMatch(/default/i)
    })
    expect(bodies[3]!.status).toBe(403)
  })

  it('leaves the default alone when a line is priced differently', async () => {
    await setDefault(product().id, { unitPriceCents: 2000 })
    const created = await ctx.request
      .post('/api/orders')
      .set(as(ctx.seed.providerUserId))
      .send({ patientId: ctx.seed.patientId })
    const orderId: number = created.body.id
    const put = await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(as(ctx.seed.providerUserId))
      .send({
        lines: [{ productId: product().id, quantity: 1, unitPriceCents: 1500 }],
      })
    expect(put.status).toBe(200)
    await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(as(ctx.seed.providerUserId))
      .send({
        lines: [{ productId: product().id, quantity: 2, unitPriceCents: 1700 }],
      })
    expect(await defaultOf(ctx.seed.providerUserId, product().id)).toBe(2000)
  })

  it('leaves existing line snapshots alone when the default changes', async () => {
    const created = await ctx.request
      .post('/api/orders')
      .set(as(ctx.seed.providerUserId))
      .send({ patientId: ctx.seed.patientId })
    const orderId: number = created.body.id
    await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(as(ctx.seed.providerUserId))
      .send({
        lines: [{ productId: product().id, quantity: 1, unitPriceCents: 1500 }],
      })
    await setDefault(product().id, { unitPriceCents: 4000 })
    const detail = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.providerUserId))
    expect(detail.body.lines[0].unitPriceCents).toBe(1500)
  })
})
