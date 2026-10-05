import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { patients, products, users } from '../db/schema'
import { as } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

interface Row {
  id: number
  name: string
  sku?: string
}

describe('GET /api/products and GET /api/patients search and pagination', () => {
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

  function listProducts(query = '') {
    return ctx.request
      .get(`/api/products${query}`)
      .set(as(ctx.seed.providerUserId))
  }

  function listPatients(query = '', userId = ctx.seed.providerUserId) {
    return ctx.request.get(`/api/patients${query}`).set(as(userId))
  }

  function skus(body: { items: Row[] }) {
    return body.items.map((p) => p.sku)
  }

  async function addProduct(sku: string, name: string) {
    await ctx.db
      .insert(products)
      .values({ sku, name, cogsCents: 500, stockQuantity: 10 })
  }

  it('returns the first page ordered by name, then id', async () => {
    await addProduct('DUP-B', 'Magnesium Glycinate 400 mg (90 caps)')

    const res = await listProducts()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 6, offset: 0, limit: 25 })
    // The duplicate name sorts after the original because its id is higher.
    expect(skus(res.body)).toEqual([
      'MAG-GLY-400',
      'DUP-B',
      'B-COMPLEX',
      'OMEGA3-1000',
      'PROBIO-50B',
      'VITD3-5000',
    ])
  })

  it('searches products by name or SKU, case-insensitively', async () => {
    const byName = await listProducts('?q=OMEGA')
    const bySku = await listProducts('?q=gly-400')
    const trimmed = await listProducts('?q=%20%20probiotic%20')
    const none = await listProducts('?q=unobtainium')

    expect(skus(byName.body)).toEqual(['OMEGA3-1000'])
    expect(byName.body.total).toBe(1)
    expect(skus(bySku.body)).toEqual(['MAG-GLY-400'])
    expect(skus(trimmed.body)).toEqual(['PROBIO-50B'])
    expect(none.body).toEqual({ items: [], total: 0, offset: 0, limit: 25 })
  })

  it('treats % and _ in the search as literal characters', async () => {
    await addProduct('PURE-100', '100% Pure Fish Oil')
    await addProduct('FISH_OIL', 'Fish Oil Liquid')

    const percent = await listProducts(`?q=${encodeURIComponent('%')}`)
    const underscore = await listProducts('?q=_')
    const backslash = await listProducts(`?q=${encodeURIComponent('\\')}`)

    expect(skus(percent.body)).toEqual(['PURE-100'])
    expect(skus(underscore.body)).toEqual(['FISH_OIL'])
    expect(backslash.body.total).toBe(0)
  })

  it('pages through every match exactly once', async () => {
    const all = await listProducts()
    const pages = await Promise.all(
      [0, 2, 4].map((offset) => listProducts(`?limit=2&offset=${offset}`)),
    )
    const past = await listProducts('?limit=2&offset=5')

    expect(pages.map((p) => p.body.items.length)).toEqual([2, 2, 1])
    pages.forEach((p, i) => {
      expect(p.body).toMatchObject({ total: 5, offset: i * 2, limit: 2 })
    })
    expect(pages.flatMap((p) => p.body.items)).toEqual(all.body.items)
    expect(past.body).toEqual({ items: [], total: 5, offset: 5, limit: 2 })
  })

  it('counts the filtered set, not the page', async () => {
    const res = await listProducts('?q=vitamin&limit=1')

    expect(res.body.items).toHaveLength(1)
    expect(res.body.total).toBe(1)
    const both = await listProducts('?q=m&limit=1')
    expect(both.body.items).toHaveLength(1)
    expect(both.body.total).toBeGreaterThan(1)
  })

  it("searches only the provider's own patients, by name and not address", async () => {
    const mine = await listPatients()
    const byName = await listPatients('?q=LEE')
    const byAddress = await listPatients('?q=austin')
    const otherProvidersPatient = await listPatients('?q=kim')
    const theirs = await listPatients('?q=kim', ctx.seed.otherProviderUserId)

    expect(mine.body.total).toBe(2)
    expect(mine.body.items.map((p: Row) => p.name)).toEqual([
      'Jordan Lee',
      'Sam Patel',
    ])
    expect(byName.body.items.map((p: Row) => p.id)).toEqual([
      ctx.seed.patientId,
    ])
    expect(byName.body.items[0]).toMatchObject({
      dateOfBirth: '1984-03-14',
      orderCount: 0,
      latestOrderStatus: null,
    })
    // Revision 3b: address does not identify a patient, so it is not searched.
    expect(byAddress.body.total).toBe(0)
    expect(otherProvidersPatient.body).toEqual({
      items: [],
      total: 0,
      offset: 0,
      limit: 25,
    })
    expect(theirs.body.items.map((p: Row) => p.name)).toEqual(['Alex Kim'])
  })

  it('matches an exact date of birth in either format, within the provider', async () => {
    const us = await listPatients(`?q=${encodeURIComponent('03/14/1984')}`)
    const iso = await listPatients('?q=1984-03-14')
    const padded = await listPatients(
      `?q=${encodeURIComponent(' 11/02/1971 ')}`,
    )
    const otherProviders = await listPatients('?q=1993-07-21')
    const theirs = await listPatients(
      '?q=1993-07-21',
      ctx.seed.otherProviderUserId,
    )

    expect(us.body.items.map((p: Row) => p.name)).toEqual(['Jordan Lee'])
    expect(iso.body.items.map((p: Row) => p.name)).toEqual(['Jordan Lee'])
    expect(padded.body.items.map((p: Row) => p.name)).toEqual(['Sam Patel'])
    expect(otherProviders.body.total).toBe(0)
    expect(theirs.body.items.map((p: Row) => p.name)).toEqual(['Alex Kim'])
  })

  it('treats partial or impossible dates as name text', async () => {
    const queries = ['1984', '03/14', '02/30/1984', '3/14/1984', '1984-3-14']

    const results = await Promise.all(
      queries.map((q) => listPatients(`?q=${encodeURIComponent(q)}`)),
    )

    expect(results.map((r) => r.body.total)).toEqual([0, 0, 0, 0, 0])
  })

  it('tells same-name patients apart by date of birth', async () => {
    const [first] = await ctx.db
      .insert(users)
      .values({ name: 'Jordan Lee', role: 'patient' })
      .returning({ id: users.id })
    const [provider] = await ctx.db
      .select({ providerId: patients.providerId })
      .from(patients)
      .where(eq(patients.id, ctx.seed.patientId))
    await ctx.db.insert(patients).values({
      userId: first!.id,
      providerId: provider!.providerId,
      dateOfBirth: '2001-09-30',
      address: '1 Test Way, Austin, TX 78701',
    })

    const byName = await listPatients('?q=jordan%20lee')
    const byDob = await listPatients(`?q=${encodeURIComponent('09/30/2001')}`)

    expect(
      byName.body.items.map((p: { dateOfBirth: string }) => p.dateOfBirth),
    ).toEqual(['1984-03-14', '2001-09-30'])
    expect(byDob.body.items.map((p: Row) => p.id)).not.toContain(
      ctx.seed.patientId,
    )
    expect(byDob.body.total).toBe(1)
  })

  it('pages patients with a limit of 1', async () => {
    const first = await listPatients('?limit=1')
    const second = await listPatients('?limit=1&offset=1')

    expect(first.body).toMatchObject({ total: 2, limit: 1, offset: 0 })
    expect(first.body.items.map((p: Row) => p.name)).toEqual(['Jordan Lee'])
    expect(second.body.items.map((p: Row) => p.name)).toEqual(['Sam Patel'])
  })

  it.each([
    ['?limit=0', 'limit'],
    ['?limit=101', 'limit'],
    ['?limit=ten', 'limit'],
    ['?offset=-1', 'offset'],
    ['?offset=1.5', 'offset'],
    [`?q=${'x'.repeat(101)}`, 'q'],
    ['?q=a&q=b', 'q'],
  ])('rejects %s with a 400 naming %s', async (query, field) => {
    const [products, patients] = await Promise.all([
      listProducts(query),
      listPatients(query),
    ])

    ;[products, patients].forEach((res) => {
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', field })
    })
  })

  it('accepts the limit bounds 1 and 100', async () => {
    const [one, hundred] = await Promise.all([
      listProducts('?limit=1'),
      listProducts('?limit=100'),
    ])

    expect(one.body.items).toHaveLength(1)
    expect(hundred.body).toMatchObject({ limit: 100, total: 5 })
  })
})
