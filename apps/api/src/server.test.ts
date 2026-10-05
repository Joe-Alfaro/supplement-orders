import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from './server'

describe('GET /api/health', () => {
  it('returns 200 when the database is reachable', async () => {
    const app = createApp({ pingDb: async () => {} })

    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', db: 'ok' })
  })

  it('returns 503 when the database is unreachable', async () => {
    const app = createApp({
      pingDb: async () => {
        throw new Error('connection refused')
      },
    })

    const res = await request(app).get('/api/health')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'degraded', db: 'unreachable' })
  })
})
