import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_DIST, webDistDir } from './config'

describe('webDistDir', () => {
  it('serves the web build in production', () => {
    expect(webDistDir({ NODE_ENV: 'production' })).toBe(DEFAULT_WEB_DIST)
    expect(DEFAULT_WEB_DIST).toMatch(/apps[/\\]web[/\\]dist$/)
  })

  it('uses SERVE_WEB_DIST when set, in any environment', () => {
    expect(webDistDir({ SERVE_WEB_DIST: '/srv/web' })).toBe('/srv/web')
    expect(
      webDistDir({ NODE_ENV: 'production', SERVE_WEB_DIST: '/srv/web' }),
    ).toBe('/srv/web')
  })

  it('serves nothing in development and tests', () => {
    expect(webDistDir({})).toBeUndefined()
    expect(webDistDir({ NODE_ENV: 'test', SERVE_WEB_DIST: '' })).toBeUndefined()
  })
})
