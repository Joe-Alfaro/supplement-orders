import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { patients, providers, users } from '../db/schema'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

interface OptionRow {
  name: string
  role: string
}

describe('GET /api/users/sign-in-options', () => {
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

  async function addPatient(providerId: number, name: string) {
    const [user] = await ctx.db
      .insert(users)
      .values({ name, role: 'patient' })
      .returning({ id: users.id })
    await ctx.db.insert(patients).values({
      userId: user!.id,
      providerId,
      dateOfBirth: '1990-01-01',
      address: '1 Test St',
    })
  }

  async function addProvider(name: string) {
    const [user] = await ctx.db
      .insert(users)
      .values({ name, role: 'provider' })
      .returning({ id: users.id })
    const [provider] = await ctx.db
      .insert(providers)
      .values({ userId: user!.id })
      .returning({ id: providers.id })
    return provider!.id
  }

  function labels(body: OptionRow[]) {
    return body.map((row) => `${row.role}:${row.name}`)
  }

  it('lists each provider, their first two patients, then the admins', async () => {
    const res = await ctx.request.get('/api/users/sign-in-options')

    expect(res.status).toBe(200)
    expect(labels(res.body)).toEqual([
      'provider:Dr. Maya Rivera',
      'patient:Jordan Lee',
      'patient:Sam Patel',
      'provider:Dr. Owen Brooks',
      'patient:Alex Kim',
      'patient:Riley Chen',
      'admin:Ada Admin',
    ])
  })

  it('needs no sign-in and returns the same shape as GET /api/users', async () => {
    const [options, all] = await Promise.all([
      ctx.request.get('/api/users/sign-in-options'),
      ctx.request.get('/api/users'),
    ])

    expect(options.status).toBe(200)
    options.body.forEach((row: { id: number }) =>
      expect(all.body).toContainEqual(row),
    )
  })

  it('keeps only the first two patients by name then id, and handles fewer than two', async () => {
    const mayaId = ctx.seed.providerUserId
    const [maya] = await ctx.db.select().from(providers)
    // Sorts between the seeded names, and a duplicate name ties on id.
    await addPatient(maya!.id, 'Aaron Zed')
    await addPatient(maya!.id, 'Jordan Lee')
    const thirdId = await addProvider('Dr. Zoe Quinn')
    await addPatient(thirdId, 'Only Child')

    const res = await ctx.request.get('/api/users/sign-in-options')

    expect(mayaId).toBeGreaterThan(0)
    expect(labels(res.body)).toEqual([
      'provider:Dr. Maya Rivera',
      'patient:Aaron Zed',
      'patient:Jordan Lee',
      'provider:Dr. Owen Brooks',
      'patient:Alex Kim',
      'patient:Riley Chen',
      'provider:Dr. Zoe Quinn',
      'patient:Only Child',
      'admin:Ada Admin',
    ])
    // The duplicate "Jordan Lee" with the lower id wins the tie.
    const jordan = res.body.find((r: OptionRow) => r.name === 'Jordan Lee')
    expect(jordan.id).toBe(ctx.seed.patientUserId)
  })

  it('leaves GET /api/users returning every user', async () => {
    const res = await ctx.request.get('/api/users')

    expect(res.body).toHaveLength(7)
  })
})
