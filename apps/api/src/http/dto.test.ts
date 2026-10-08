import {
  apiErrorResponseSchema,
  dashboardDtoSchema,
  patientDtoSchema,
  patientPageDtoSchema,
  patientOrderDetailDtoSchema,
  patientOrderSummaryDtoSchema,
  productPageDtoSchema,
  providerOrderDetailDtoSchema,
  providerOrderSummaryDtoSchema,
  signInOptionDtoSchema,
  userDtoSchema,
} from '@supplement-orders/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { as, createDraft, createSentOrder, pay } from '../testing/flows'

/** Every response body must parse with the shared schema the web app imports. */
function expectShape(schema: z.ZodType, body: unknown) {
  const result = z.strictObject({ body: schema }).safeParse({ body })
  expect(result.error?.issues ?? []).toEqual([])
}

describe('responses match the shared DTO schemas', () => {
  let ctx: InternalTestContext

  beforeAll(async () => {
    ctx = await createInternalTestContext()
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx.close()
  })

  it('covers every endpoint', async () => {
    const provider = as(ctx.seed.providerUserId)
    const patient = as(ctx.seed.patientUserId)
    const draftId = await createDraft(ctx)
    const incompleteId = await createDraft(ctx, [{}])
    const paidId = await createSentOrder(ctx)
    const paid = await pay(ctx, paidId)

    expectShape(
      userDtoSchema,
      (await ctx.request.get('/api/users/me').set(provider)).body,
    )
    expectShape(
      z.array(signInOptionDtoSchema),
      (await ctx.request.get('/api/users/sign-in-options')).body,
    )
    expectShape(
      productPageDtoSchema,
      (await ctx.request.get('/api/products').set(provider)).body,
    )
    expectShape(
      patientPageDtoSchema,
      (await ctx.request.get('/api/patients').set(provider)).body,
    )
    expectShape(
      patientDtoSchema,
      (
        await ctx.request
          .get(`/api/patients/${ctx.seed.patientId}`)
          .set(provider)
      ).body,
    )
    expectShape(
      z.array(providerOrderSummaryDtoSchema),
      (
        await ctx.request
          .get(`/api/orders?patientId=${ctx.seed.patientId}`)
          .set(provider)
      ).body,
    )
    expectShape(
      z.array(patientOrderSummaryDtoSchema),
      (await ctx.request.get('/api/orders').set(patient)).body,
    )
    expectShape(
      providerOrderDetailDtoSchema,
      (await ctx.request.get(`/api/orders/${draftId}`).set(provider)).body,
    )
    expectShape(
      providerOrderDetailDtoSchema,
      (await ctx.request.get(`/api/orders/${incompleteId}`).set(provider)).body,
    )
    expectShape(
      providerOrderDetailDtoSchema,
      (await ctx.request.get(`/api/orders/${paidId}`).set(provider)).body,
    )
    expectShape(patientOrderDetailDtoSchema, paid.body)
    expectShape(
      dashboardDtoSchema,
      (await ctx.request.get('/api/dashboard').set(provider)).body,
    )
    expectShape(
      apiErrorResponseSchema,
      (await ctx.request.get('/api/dashboard').set(patient)).body,
    )
  })
})
