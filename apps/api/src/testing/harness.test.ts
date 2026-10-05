import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext, type TestContext } from './harness'

describe('test harness', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await createTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx.close()
  })

  it('seeds ids that satisfy the contract and survive a reset', async () => {
    const before = ctx.seed
    await ctx.reset()

    expect(ctx.seed).toEqual(before)
    expect(ctx.seed.products.length).toBeGreaterThanOrEqual(3)
    expect(ctx.seed.products.every((p) => p.stockQuantity >= 10)).toBe(true)
  })

  it('serves the seeded users with their stored roles', async () => {
    const res = await ctx.request.get('/api/users')

    expect(res.status).toBe(200)
    const roles = new Map(
      res.body.map((u: { id: number; role: string }) => [u.id, u.role]),
    )
    expect(roles.get(ctx.seed.providerUserId)).toBe('provider')
    expect(roles.get(ctx.seed.otherProviderUserId)).toBe('provider')
    expect(roles.get(ctx.seed.patientUserId)).toBe('patient')
    expect(roles.get(ctx.seed.otherPatientUserId)).toBe('patient')
  })
})
