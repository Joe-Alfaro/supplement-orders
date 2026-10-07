import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { Db } from './db/client'
import { ConsoleNotifier, FakePaymentGateway } from './seams'
import { createApp } from './server'

function appWithPing(pingDb: () => Promise<void>) {
  // The health check never touches db, so no database is needed here.
  return createApp({
    db: {} as Db,
    pingDb,
    // The gateway is never called here, so it needs no real database.
    gateway: new FakePaymentGateway({} as Db),
    notifier: new ConsoleNotifier(),
  })
}

describe('GET /api/health', () => {
  it('returns 200 when the database is reachable', async () => {
    const app = appWithPing(async () => {})

    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', db: 'ok' })
  })

  it('returns 503 when the database is unreachable', async () => {
    const app = appWithPing(async () => {
      throw new Error('connection refused')
    })

    const res = await request(app).get('/api/health')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'degraded', db: 'unreachable' })
  })
})
