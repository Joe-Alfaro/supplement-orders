import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  as,
  createDraft,
  createSentOrder,
  pay,
  withPaidOrdersUnfrozen,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 18: 18.3 soldByProduct and 18.4 L6 (404 not 403) / L8 (100 lines).
// soldByProduct item shape chosen by these tests:
//   { productId, productName, unitsSold, revenueCents }
interface SoldRow {
  productId: number
  productName: string
  unitsSold: number
  revenueCents: number
}

describe('revision 18 HTTP contracts', () => {
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

  const provider = () => as(ctx.seed.providerUserId)
  const other = () => as(ctx.seed.otherProviderUserId)

  function dashboard(query: Record<string, string>, user = provider()) {
    return ctx.request.get('/api/dashboard').query(query).set(user)
  }
  async function paidOrder(
    lines: { productId: number; quantity: number; unitPriceCents: number }[],
  ) {
    const id = await createSentOrder(ctx, lines)
    expect((await pay(ctx, id)).status).toBe(200)
    return id
  }

  // ------------------------------------------------------------- 18.3
  it('18.3 soldByProduct lists units and revenue per product, revenue descending, from this provider paid orders only', async () => {
    const [a, b, c] = ctx.seed.products
    await paidOrder([
      { productId: a!.id, quantity: 3, unitPriceCents: a!.cogsCents + 500 },
      { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents + 5000 },
    ])
    await paidOrder([
      { productId: a!.id, quantity: 2, unitPriceCents: a!.cogsCents + 500 },
    ])
    // Neither a pending order nor another provider's paid order counts.
    await createSentOrder(ctx, [
      { productId: c!.id, quantity: 4, unitPriceCents: c!.cogsCents + 900 },
    ])
    const response = await dashboard({ range: 'all' })
    expect(response.status).toBe(200)
    const aRevenue = 5 * (a!.cogsCents + 500)
    const bRevenue = b!.cogsCents + 5000
    const expected = [
      { productId: a!.id, unitsSold: 5, revenueCents: aRevenue },
      { productId: b!.id, unitsSold: 1, revenueCents: bRevenue },
    ].sort((x, y) => y.revenueCents - x.revenueCents)
    expect(response.body.soldByProduct).toEqual(
      expected.map((row) => ({
        ...row,
        productName: expect.any(String),
      })),
    )
    const names = await ctx.db.execute<{ id: number; name: string }>(
      sql`select id, name from products where id in (${a!.id}, ${b!.id})`,
    )
    ;(response.body.soldByProduct as SoldRow[]).forEach((row) =>
      expect(row.productName).toBe(
        names.rows.find((n) => n.id === row.productId)!.name,
      ),
    )
    const otherView = await dashboard({ range: 'all' }, other())
    expect(otherView.body.soldByProduct).toEqual([])
  })

  it('18.3 soldByProduct honours the date range and is empty without sales', async () => {
    const a = ctx.seed.products[0]!
    expect((await dashboard({ range: 'all' })).body.soldByProduct).toEqual([])
    const id = await paidOrder([
      { productId: a.id, quantity: 1, unitPriceCents: a.cogsCents + 700 },
    ])
    await withPaidOrdersUnfrozen(ctx.db, (tx) =>
      tx.execute(
        sql`update orders set paid_at = '2020-01-15T12:00:00Z' where id = ${id}`,
      ),
    )
    expect((await dashboard({ range: 'month' })).body.soldByProduct).toEqual([])
    expect((await dashboard({ range: 'all' })).body.soldByProduct).toHaveLength(
      1,
    )
  })

  it('18.3 soldByProduct totals agree with GMV', async () => {
    const [a, b] = ctx.seed.products
    await paidOrder([
      { productId: a!.id, quantity: 2, unitPriceCents: a!.cogsCents + 321 },
      { productId: b!.id, quantity: 3, unitPriceCents: b!.cogsCents + 777 },
    ])
    const { body } = await dashboard({ range: 'all' })
    expect(
      (body.soldByProduct as SoldRow[]).reduce((s, r) => s + r.revenueCents, 0),
    ).toBe(body.gmvCents)
  })

  // ------------------------------------------------------------- L6
  function normalised(body: { error: { code: string; message: string } }) {
    return {
      code: body.error.code,
      message: body.error.message.replace(/\d+/g, '#'),
    }
  }

  it('L6 another practice gets the same 404 NOT_FOUND for an order as for a missing one', async () => {
    const id = await createSentOrder(ctx)
    const notYours = await ctx.request.get(`/api/orders/${id}`).set(other())
    const missing = await ctx.request.get('/api/orders/999999').set(other())
    expect(notYours.status).toBe(404)
    expect(notYours.body.error.code).toBe('NOT_FOUND')
    expect(normalised(notYours.body)).toEqual(normalised(missing.body))
  })

  it.each(['send', 'cancel', 'reopen', 'delete'] as const)(
    'L6 another practice cannot probe an order through %s (404 NOT_FOUND)',
    async (verb) => {
      const id = await createSentOrder(ctx)
      const response =
        verb === 'delete'
          ? await ctx.request.delete(`/api/orders/${id}`).set(other())
          : await ctx.request.post(`/api/orders/${id}/${verb}`).set(other())
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('NOT_FOUND')
    },
  )

  it('L6 another practice gets 404 NOT_FOUND for lines edits on an order', async () => {
    const id = await createDraft(ctx)
    const response = await ctx.request
      .put(`/api/orders/${id}/lines`)
      .set(other())
      .send({ lines: [] })
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('NOT_FOUND')
  })

  it('L6 another practice gets 404 NOT_FOUND for a patient, and cannot start an order for one', async () => {
    const read = await ctx.request
      .get(`/api/patients/${ctx.seed.patientId}`)
      .set(other())
    const missing = await ctx.request.get('/api/patients/999999').set(other())
    expect(read.status).toBe(404)
    expect(read.body.error.code).toBe('NOT_FOUND')
    expect(normalised(read.body)).toEqual(normalised(missing.body))
    const created = await ctx.request
      .post('/api/orders')
      .set(other())
      .send({ patientId: ctx.seed.patientId })
    expect(created.status).toBe(404)
    expect(created.body.error.code).toBe('NOT_FOUND')
  })

  // ------------------------------------------------------------- L8
  async function manyProducts(count: number) {
    const rows = await ctx.db.execute<{ id: number }>(sql`
      insert into products (sku, name, cogs_cents, stock_quantity)
      select 'REV18-' || n, 'Rev18 product ' || n, 100, 10 from generate_series(1, ${count}) n
      returning id`)
    return rows.rows.map((r) => ({
      productId: r.id,
      quantity: 1,
      unitPriceCents: 1000,
    }))
  }
  async function putLines(lines: object[]) {
    const created = await ctx.request
      .post('/api/orders')
      .set(provider())
      .send({ patientId: ctx.seed.patientId })
    return ctx.request
      .put(`/api/orders/${created.body.id}/lines`)
      .set(provider())
      .send({ lines })
  }

  it('L8 an order may have exactly 100 lines', async () => {
    const lines = await manyProducts(100)
    expect((await putLines(lines)).status).toBe(200)
  })

  it('L8 101 lines are rejected with 400 VALIDATION_ERROR on field lines', async () => {
    const lines = await manyProducts(101)
    const response = await putLines(lines)
    expect(response.status).toBe(400)
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'lines',
    })
  })
})
