import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { USER_ID_HEADER } from '@supplement-orders/domain'
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
    const roles = await Promise.all(
      [
        ctx.seed.providerUserId,
        ctx.seed.otherProviderUserId,
        ctx.seed.patientUserId,
        ctx.seed.otherPatientUserId,
      ].map(async (userId) => {
        const res = await ctx.request
          .get('/api/users/me')
          .set(USER_ID_HEADER, String(userId))
        expect(res.status).toBe(200)
        return res.body.role
      }),
    )

    expect(roles).toEqual(['provider', 'provider', 'patient', 'patient'])
  })
})
