import { apiErrorResponseSchema } from '@supplement-orders/domain'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { as, createSentOrder } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { errorHandler } from './errors'

// Revision 11 (third Codex audit, N6): caller mistakes at the boundary are
// 4xx with the standard error shape, never a 500.
describe('request boundaries', () => {
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

  const provider = () => as(ctx.seed.providerUserId)
  const POSTGRES_INTEGER_MAX = 2_147_483_647

  function expectError(
    res: request.Response,
    status: number,
    code: string,
    field?: string,
  ) {
    expect(res.status).toBe(status)
    expect(apiErrorResponseSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.error.code).toBe(code)
    if (field !== undefined) expect(res.body.error.field).toBe(field)
  }

  it.each([
    ['GET', `/api/orders/${POSTGRES_INTEGER_MAX + 1}`, 'id'],
    ['GET', `/api/patients/${POSTGRES_INTEGER_MAX + 1}`, 'id'],
    ['GET', `/api/orders?patientId=${POSTGRES_INTEGER_MAX + 1}`, 'patientId'],
    ['POST', `/api/orders/${POSTGRES_INTEGER_MAX + 1}/send`, 'id'],
    ['DELETE', `/api/orders/${Number.MAX_SAFE_INTEGER}`, 'id'],
  ])(
    '%s %s past the integer column range is a 400 on %s',
    async (method, path, field) => {
      const send = {
        GET: () => ctx.request.get(path),
        POST: () => ctx.request.post(path),
        DELETE: () => ctx.request.delete(path),
      }[method]!
      const call = send()

      expectError(await call.set(provider()), 400, 'VALIDATION_ERROR', field)
    },
  )

  it('accepts the largest integer id and reports it missing', async () => {
    const res = await ctx.request
      .get(`/api/orders/${POSTGRES_INTEGER_MAX}`)
      .set(provider())

    expectError(res, 404, 'NOT_FOUND')
  })

  it('rejects an out-of-range id inside a request body', async () => {
    const created = await ctx.request
      .post('/api/orders')
      .set(provider())
      .send({ patientId: POSTGRES_INTEGER_MAX + 1 })
    const orderId = await createSentOrder(ctx)
    await ctx.request.post(`/api/orders/${orderId}/cancel`).set(provider())
    await ctx.request.post(`/api/orders/${orderId}/reopen`).set(provider())
    const lines = await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(provider())
      .send({ lines: [{ productId: POSTGRES_INTEGER_MAX + 1 }] })

    expectError(created, 400, 'VALIDATION_ERROR', 'patientId')
    expectError(lines, 400, 'VALIDATION_ERROR', 'lines.0.productId')
  })

  it('answers an oversized JSON body with 413, not 500 (audit probe size)', async () => {
    const res = await ctx.request
      .post('/api/orders')
      .set(provider())
      .set('content-type', 'application/json')
      .send(JSON.stringify({ patientId: 1, padding: 'x'.repeat(110_000) }))

    expectError(res, 413, 'PAYLOAD_TOO_LARGE')
  })

  it('answers other body-parser client errors with their own 4xx', async () => {
    const res = await ctx.request
      .post('/api/orders')
      .set(provider())
      .set('content-type', 'application/json; charset=klingon')
      .send('{"patientId":1}')

    expect(res.status).toBe(415)
    expect(apiErrorResponseSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('still hides unexpected errors behind a generic 500', async () => {
    const app = express()
    app.get('/boom', () => {
      throw Object.assign(new Error('secret internals'), { status: 503 })
    })
    app.use(errorHandler)

    const res = await request(app).get('/boom')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    })
  })
})
