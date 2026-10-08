import { describe, expect, it } from 'vitest'
import { testDatabaseName, testDatabaseUrl } from './databases'

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

describe('testDatabaseName', () => {
  it('uses TEST_DATABASE_NAME verbatim when set', () => {
    const name = testDatabaseName(
      { TEST_DATABASE_NAME: 'my_tests', AO_SESSION_ID: 'ignored' },
      '/repo',
    )

    expect(name).toBe('my_tests')
  })

  it('rejects a TEST_DATABASE_NAME that is not a plain identifier', () => {
    expect(() =>
      testDatabaseName({ TEST_DATABASE_NAME: 'bad-name; drop' }, '/repo'),
    ).toThrow(/TEST_DATABASE_NAME/)
    expect(() =>
      testDatabaseName({ TEST_DATABASE_NAME: 'x'.repeat(64) }, '/repo'),
    ).toThrow(/TEST_DATABASE_NAME/)
  })

  it('derives the name from AO_SESSION_ID, normalized to an identifier', () => {
    const name = testDatabaseName(
      { AO_SESSION_ID: 'Supplement-Orders-13' },
      '/repo',
    )

    expect(name).toBe('supplement_orders_test_supplement_orders_13')
  })

  it('keeps long session ids distinct and within 63 characters', () => {
    const a = testDatabaseName({ AO_SESSION_ID: `${'s'.repeat(80)}-1` }, '/r')
    const b = testDatabaseName({ AO_SESSION_ID: `${'s'.repeat(80)}-2` }, '/r')

    expect(a).toMatch(IDENTIFIER)
    expect(b).toMatch(IDENTIFIER)
    expect(a).not.toBe(b)
  })

  it('falls back to a short stable hash of the repo root', () => {
    const a = testDatabaseName({}, '/Users/x/worktrees/one')
    const again = testDatabaseName({}, '/Users/x/worktrees/one')
    const b = testDatabaseName({}, '/Users/x/worktrees/two')

    expect(a).toMatch(/^supplement_orders_test_[0-9a-f]{8}$/)
    expect(again).toBe(a)
    expect(b).not.toBe(a)
  })

  it('treats empty variables as unset', () => {
    const name = testDatabaseName(
      { TEST_DATABASE_NAME: '', AO_SESSION_ID: '' },
      '/repo',
    )

    expect(name).toMatch(/^supplement_orders_test_[0-9a-f]{8}$/)
  })
})

describe('testDatabaseUrl', () => {
  it('prefers TEST_DATABASE_URL over any derived name', () => {
    const url = testDatabaseUrl(
      { TEST_DATABASE_URL: 'postgres://u:p@h:1/explicit', AO_SESSION_ID: 's' },
      '/repo',
    )

    expect(url).toBe('postgres://u:p@h:1/explicit')
  })

  it('puts the derived name beside DATABASE_URL', () => {
    const url = testDatabaseUrl(
      {
        DATABASE_URL: 'postgres://u:p@h:1/supplement_orders',
        AO_SESSION_ID: 'abc',
      },
      '/repo',
    )

    expect(url).toBe('postgres://u:p@h:1/supplement_orders_test_abc')
  })
})
