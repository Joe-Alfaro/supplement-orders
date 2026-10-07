import {
  STOCK_QUANTITY_MAX,
  adminProductDtoSchema,
  adminProductPageDtoSchema,
  stockChangedErrorResponseSchema,
} from '@supplement-orders/domain'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { inventoryAdjustments, products } from '../db/schema'
import type { ChargeOptions, ChargeRequest } from '../seams'
import { as, createSentOrder, pay, setStock } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 13: an admin manages available stock. Increment is one atomic
// UPDATE; set is a compare-and-set that answers 409 STOCK_CHANGED with the
// current value. Every successful change writes one inventory_adjustments row
// in the same transaction; a 400, 404 or 409 writes none.

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

function admin() {
  return as(ctx.seed.adminUserId)
}

function firstProduct() {
  return ctx.seed.products[0]!
}

function increment(productId: number, body: unknown, userId?: number) {
  return ctx.request
    .post(`/api/admin/products/${productId}/stock/increment`)
    .set(as(userId ?? ctx.seed.adminUserId))
    .send(body as object)
}

function setTo(productId: number, body: unknown, userId?: number) {
  return ctx.request
    .put(`/api/admin/products/${productId}/stock`)
    .set(as(userId ?? ctx.seed.adminUserId))
    .send(body as object)
}

async function stockOf(productId: number) {
  const [row] = await ctx.db
    .select({ stockQuantity: products.stockQuantity })
    .from(products)
    .where(eq(products.id, productId))
  return row!.stockQuantity
}

function adjustments() {
  return ctx.db
    .select()
    .from(inventoryAdjustments)
    .orderBy(asc(inventoryAdjustments.id))
}

function expectError(
  res: { status: number; body: { error?: { code?: string; field?: string } } },
  status: number,
  code: string,
  field?: string,
) {
  expect(res.status).toBe(status)
  expect(res.body.error?.code).toBe(code)
  if (field !== undefined) expect(res.body.error?.field).toBe(field)
}

describe('admin persona', () => {
  it('lists Ada Admin among the users with no provider or patient id', async () => {
    const res = await ctx.request.get('/api/users')

    expect(res.status).toBe(200)
    expect(res.body).toContainEqual({
      id: ctx.seed.adminUserId,
      name: 'Ada Admin',
      role: 'admin',
      providerId: null,
      patientId: null,
    })
  })
})

describe('admin endpoint access', () => {
  function adminCalls(userId?: number) {
    const id = firstProduct().id
    const withUser = <T extends { set: (h: Record<string, string>) => T }>(
      req: T,
    ) => (userId === undefined ? req : req.set(as(userId)))
    return [
      withUser(ctx.request.get('/api/admin/products')),
      withUser(
        ctx.request
          .post(`/api/admin/products/${id}/stock/increment`)
          .send({ by: 1 }),
      ),
      withUser(
        ctx.request
          .put(`/api/admin/products/${id}/stock`)
          .send({ stockQuantity: 1, expectedStockQuantity: 120 }),
      ),
    ]
  }

  it('answers 401 without a user', async () => {
    const results = await Promise.all(adminCalls())
    results.forEach((res) => expectError(res, 401, 'UNAUTHENTICATED'))
  })

  it('answers 403 to providers and patients and changes nothing', async () => {
    const before = await stockOf(firstProduct().id)
    const results = await Promise.all([
      ...adminCalls(ctx.seed.providerUserId),
      ...adminCalls(ctx.seed.patientUserId),
    ])

    results.forEach((res) => expectError(res, 403, 'FORBIDDEN'))
    expect(await stockOf(firstProduct().id)).toBe(before)
    expect(await adjustments()).toEqual([])
  })

  it('answers 403 to an admin on provider and patient endpoints', async () => {
    const orderId = await createSentOrder(ctx)
    const results = await Promise.all([
      ctx.request.get('/api/products').set(admin()),
      ctx.request.get('/api/patients').set(admin()),
      ctx.request.get(`/api/patients/${ctx.seed.patientId}`).set(admin()),
      ctx.request.get('/api/orders').set(admin()),
      ctx.request.get('/api/orders?status=all').set(admin()),
      ctx.request.get(`/api/orders/${orderId}`).set(admin()),
      ctx.request
        .post('/api/orders')
        .set(admin())
        .send({ patientId: ctx.seed.patientId }),
      ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(admin())
        .send({ expectedRevision: 1, expectedTotalCents: 1 }),
      ctx.request.get('/api/dashboard').set(admin()),
    ])

    results.forEach((res) => expectError(res, 403, 'FORBIDDEN'))
  })
})

describe('GET /api/admin/products', () => {
  it('pages the catalog by name, then id, with wholesale cost and stock', async () => {
    const res = await ctx.request
      .get('/api/admin/products?limit=2')
      .set(admin())

    expect(res.status).toBe(200)
    const page = adminProductPageDtoSchema.parse(res.body)
    expect(page).toMatchObject({ total: 5, offset: 0, limit: 2 })
    page.items.forEach((item) =>
      expect(Object.keys(item).sort()).toEqual(
        ['id', 'name', 'stockQuantity', 'wholesaleCostCents'].sort(),
      ),
    )
    expect(page.items).toEqual([
      {
        id: 2,
        name: 'Magnesium Glycinate 400 mg (90 caps)',
        wholesaleCostCents: 1275,
        stockQuantity: 80,
      },
      {
        id: 5,
        name: 'Methylated B-Complex (60 caps)',
        wholesaleCostCents: 990,
        stockQuantity: 25,
      },
    ])

    const next = await ctx.request
      .get('/api/admin/products?limit=2&offset=4')
      .set(admin())
    expect(next.body.items.map((p: { id: number }) => p.id)).toEqual([1])
  })

  it('searches by name, case-insensitively', async () => {
    const res = await ctx.request
      .get('/api/admin/products?q=OMEGA')
      .set(admin())

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.items[0].name).toBe(
      'Omega-3 Fish Oil 1000 mg (60 softgels)',
    )
  })

  it('rejects an invalid query', async () => {
    const res = await ctx.request
      .get('/api/admin/products?limit=0')
      .set(admin())
    expectError(res, 400, 'VALIDATION_ERROR', 'limit')
  })
})

describe('POST /api/admin/products/:id/stock/increment', () => {
  it('adds to stock, returns the product and records one adjustment', async () => {
    const product = firstProduct()

    const res = await increment(product.id, { by: 10 })

    expect(res.status).toBe(200)
    expect(adminProductDtoSchema.parse(res.body)).toEqual({
      id: product.id,
      name: 'Vitamin D3 5000 IU (120 softgels)',
      wholesaleCostCents: product.cogsCents,
      stockQuantity: product.stockQuantity + 10,
    })
    expect(await stockOf(product.id)).toBe(product.stockQuantity + 10)
    const [row, ...rest] = await adjustments()
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      productId: product.id,
      userId: ctx.seed.adminUserId,
      kind: 'increment',
      previousQuantity: product.stockQuantity,
      newQuantity: product.stockQuantity + 10,
    })
    expect(row!.createdAt).toBeInstanceOf(Date)
  })

  it('allows reaching the bound exactly and rejects going past it', async () => {
    const product = firstProduct()
    await setStock(ctx, product.id, STOCK_QUANTITY_MAX - 2)

    const over = await increment(product.id, { by: 3 })
    expectError(over, 400, 'VALIDATION_ERROR', 'by')
    expect(await stockOf(product.id)).toBe(STOCK_QUANTITY_MAX - 2)
    expect(await adjustments()).toEqual([])

    const exact = await increment(product.id, { by: 2 })
    expect(exact.status).toBe(200)
    expect(exact.body.stockQuantity).toBe(STOCK_QUANTITY_MAX)
    expect(await adjustments()).toHaveLength(1)
  })

  it('never loses a concurrent increment', async () => {
    const product = firstProduct()
    const n = 25

    const results = await Promise.all(
      Array.from({ length: n }, () => increment(product.id, { by: 1 })),
    )

    results.forEach((res) => expect(res.status).toBe(200))
    expect(await stockOf(product.id)).toBe(product.stockQuantity + n)
    const rows = await adjustments()
    expect(rows).toHaveLength(n)
    rows.forEach((row) =>
      expect(row.newQuantity).toBe(row.previousQuantity + 1),
    )
    expect(new Set(rows.map((row) => row.previousQuantity)).size).toBe(n)
  })

  it('answers 404 for an unknown product', async () => {
    const res = await increment(9999, { by: 1 })
    expectError(res, 404, 'NOT_FOUND')
    expect(await adjustments()).toEqual([])
  })

  it.each([
    ['a non-integer', { by: 1.5 }],
    ['a string', { by: '5' }],
    ['zero', { by: 0 }],
    ['a negative', { by: -3 }],
    ['over the bound', { by: STOCK_QUANTITY_MAX + 1 }],
    ['a missing value', {}],
  ])('rejects %s with 400 on by and changes nothing', async (_label, body) => {
    const product = firstProduct()

    const res = await increment(product.id, body)

    expectError(res, 400, 'VALIDATION_ERROR', 'by')
    expect(await stockOf(product.id)).toBe(product.stockQuantity)
    expect(await adjustments()).toEqual([])
  })

  it('rejects a malformed product id', async () => {
    const res = await ctx.request
      .post('/api/admin/products/abc/stock/increment')
      .set(admin())
      .send({ by: 1 })
    expectError(res, 400, 'VALIDATION_ERROR', 'id')
  })
})

describe('PUT /api/admin/products/:id/stock', () => {
  it('sets stock when the expected value matches and records one adjustment', async () => {
    const product = firstProduct()

    const res = await setTo(product.id, {
      stockQuantity: 7,
      expectedStockQuantity: product.stockQuantity,
    })

    expect(res.status).toBe(200)
    expect(adminProductDtoSchema.parse(res.body)).toEqual({
      id: product.id,
      name: 'Vitamin D3 5000 IU (120 softgels)',
      wholesaleCostCents: product.cogsCents,
      stockQuantity: 7,
    })
    expect(await stockOf(product.id)).toBe(7)
    const rows = await adjustments()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      productId: product.id,
      userId: ctx.seed.adminUserId,
      kind: 'set',
      previousQuantity: product.stockQuantity,
      newQuantity: 7,
    })
  })

  it('accepts zero and the upper bound', async () => {
    const product = firstProduct()

    const zero = await setTo(product.id, {
      stockQuantity: 0,
      expectedStockQuantity: product.stockQuantity,
    })
    expect(zero.status).toBe(200)
    const max = await setTo(product.id, {
      stockQuantity: STOCK_QUANTITY_MAX,
      expectedStockQuantity: 0,
    })
    expect(max.status).toBe(200)
    expect(await stockOf(product.id)).toBe(STOCK_QUANTITY_MAX)
  })

  it('answers 409 STOCK_CHANGED with the current value when another admin incremented first', async () => {
    const product = firstProduct()
    expect((await increment(product.id, { by: 5 })).status).toBe(200)

    const res = await setTo(product.id, {
      stockQuantity: 3,
      expectedStockQuantity: product.stockQuantity,
    })

    expectError(res, 409, 'STOCK_CHANGED')
    expect(stockChangedErrorResponseSchema.parse(res.body)).toMatchObject({
      error: { currentStockQuantity: product.stockQuantity + 5 },
    })
    expect(await stockOf(product.id)).toBe(product.stockQuantity + 5)
    expect(await adjustments()).toHaveLength(1)
  })

  it('answers 409 when a payment reserved stock after the admin loaded it', async () => {
    const product = firstProduct()
    const loaded = await ctx.request
      .get('/api/admin/products?q=Vitamin')
      .set(admin())
    const loadedStock: number = loaded.body.items[0].stockQuantity
    expect(loadedStock).toBe(product.stockQuantity)
    // sampleLines puts 2 of the first product on the order.
    const orderId = await createSentOrder(ctx)

    // Hold the charge open: the attempt and its stock hold are already committed.
    const original = ctx.gateway.charge.bind(ctx.gateway)
    let reachedCharge!: () => void
    let releaseCharge!: () => void
    const atCharge = new Promise<void>((resolve) => (reachedCharge = resolve))
    const gate = new Promise<void>((resolve) => (releaseCharge = resolve))
    ctx.gateway.charge = async (
      request: ChargeRequest,
      options?: ChargeOptions,
    ) => {
      reachedCharge()
      await gate
      return original(request, options)
    }
    try {
      const paying = pay(ctx, orderId)
      await atCharge

      const res = await setTo(product.id, {
        stockQuantity: 500,
        expectedStockQuantity: loadedStock,
      })

      expectError(res, 409, 'STOCK_CHANGED')
      expect(res.body.error.currentStockQuantity).toBe(loadedStock - 2)
      releaseCharge()
      expect((await paying).status).toBe(200)
    } finally {
      releaseCharge()
      Reflect.deleteProperty(ctx.gateway, 'charge')
    }

    expect(await stockOf(product.id)).toBe(loadedStock - 2)
    expect(await adjustments()).toEqual([])

    const retried = await setTo(product.id, {
      stockQuantity: 500,
      expectedStockQuantity: loadedStock - 2,
    })
    expect(retried.status).toBe(200)
    expect(await stockOf(product.id)).toBe(500)
  })

  it('answers 404 for an unknown product', async () => {
    const res = await setTo(9999, {
      stockQuantity: 1,
      expectedStockQuantity: 0,
    })
    expectError(res, 404, 'NOT_FOUND')
    expect(await adjustments()).toEqual([])
  })

  it.each([
    [
      'a non-integer stock',
      { stockQuantity: 1.5, expectedStockQuantity: 120 },
      'stockQuantity',
    ],
    [
      'a negative stock',
      { stockQuantity: -1, expectedStockQuantity: 120 },
      'stockQuantity',
    ],
    [
      'stock over the bound',
      { stockQuantity: STOCK_QUANTITY_MAX + 1, expectedStockQuantity: 120 },
      'stockQuantity',
    ],
    [
      'a string stock',
      { stockQuantity: '9', expectedStockQuantity: 120 },
      'stockQuantity',
    ],
    [
      'a non-integer expected',
      { stockQuantity: 9, expectedStockQuantity: 119.5 },
      'expectedStockQuantity',
    ],
    [
      'a negative expected',
      { stockQuantity: 9, expectedStockQuantity: -1 },
      'expectedStockQuantity',
    ],
    ['a missing expected', { stockQuantity: 9 }, 'expectedStockQuantity'],
  ])('rejects %s with 400 and changes nothing', async (_label, body, field) => {
    const product = firstProduct()

    const res = await setTo(product.id, body)

    expectError(res, 400, 'VALIDATION_ERROR', field)
    expect(await stockOf(product.id)).toBe(product.stockQuantity)
    expect(await adjustments()).toEqual([])
  })
})

describe('inventory_adjustments', () => {
  it('is append-only in the database', async () => {
    expect((await increment(firstProduct().id, { by: 1 })).status).toBe(200)
    const [row] = await adjustments()

    await expect(
      ctx.db
        .update(inventoryAdjustments)
        .set({ newQuantity: 0 })
        .where(eq(inventoryAdjustments.id, row!.id)),
    ).rejects.toThrow()
    await expect(
      ctx.db
        .delete(inventoryAdjustments)
        .where(eq(inventoryAdjustments.id, row!.id)),
    ).rejects.toThrow()
    expect(await adjustments()).toEqual([row])
  })
})
