import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../db/client'
import { ConsoleNotifier, FakePaymentGateway } from '../seams'
import { createApp } from '../server'

const INDEX_HTML =
  '<!doctype html><title>Supplement Orders</title><div id="app"></div>'
const ASSET_JS = 'console.log("app")'

let tmpRoot: string
let webDist: string

function appServingWeb(dist: string | undefined) {
  // None of these requests reach the database.
  return createApp({
    db: {} as Db,
    pingDb: async () => {},
    // The gateway is never called here, so it needs no real database.
    gateway: new FakePaymentGateway({} as Db),
    notifier: new ConsoleNotifier(),
    webDist: dist,
  })
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'supplement-orders-web-dist-'))
  // A dot-directory in the absolute path (like ~/.ao/worktrees) must not hide
  // the build: send() ignores dotfiles anywhere in a path it is given.
  webDist = join(tmpRoot, '.checkout', 'dist')
  mkdirSync(join(webDist, 'assets'), { recursive: true })
  writeFileSync(join(webDist, 'index.html'), INDEX_HTML)
  writeFileSync(join(webDist, 'assets', 'index-abc123.js'), ASSET_JS)
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('serving the built web app', () => {
  it('serves index.html at the root without caching it', async () => {
    const res = await request(appServingWeb(webDist)).get('/')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.text).toBe(INDEX_HTML)
  })

  it('falls back to index.html for client-side routes', async () => {
    const res = await request(appServingWeb(webDist)).get('/orders?status=paid')

    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.text).toBe(INDEX_HTML)
  })

  it('serves hashed assets with a long immutable cache', async () => {
    const res = await request(appServingWeb(webDist)).get(
      '/assets/index-abc123.js',
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/javascript/)
    expect(res.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(res.text).toBe(ASSET_JS)
  })

  it('returns 404 for a missing asset instead of index.html', async () => {
    const res = await request(appServingWeb(webDist)).get(
      '/assets/missing-000.js',
    )

    expect(res.status).toBe(404)
    expect(res.text).not.toContain('<div id="app">')
  })

  it('does not fall back for non-GET requests', async () => {
    const res = await request(appServingWeb(webDist)).post('/orders')

    expect(res.status).toBe(404)
    expect(res.text).not.toContain('<div id="app">')
  })

  it('leaves /api routes unchanged', async () => {
    const app = appServingWeb(webDist)

    const health = await request(app).get('/api/health')
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ status: 'ok', db: 'ok' })

    const unknown = await request(app).get('/api/does-not-exist')
    expect(unknown.status).toBe(404)
    expect(unknown.headers['content-type']).toMatch(/application\/json/)
    expect(unknown.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such endpoint' },
    })
  })

  it('serves nothing outside /api when no web build is configured', async () => {
    const res = await request(appServingWeb(undefined)).get('/orders')

    expect(res.status).toBe(404)
    expect(res.text).not.toContain('<div id="app">')
  })
})
