import { describe, expect, it } from 'vitest'
import {
  listOrdersQuerySchema,
  listPatientsQuerySchema,
  listQuerySchema,
} from './requests'
import { pageSchema, productDtoSchema } from './responses'

function issuePath(input: Record<string, unknown>) {
  const result = listQuerySchema.safeParse(input)
  expect(result.success).toBe(false)
  return result.error?.issues[0]?.path
}

describe('listQuerySchema', () => {
  it('defaults to the first page of 25 with no search', () => {
    expect(listQuerySchema.parse({})).toEqual({ q: null, offset: 0, limit: 25 })
  })

  it('trims q and treats a blank q as no search', () => {
    expect(listQuerySchema.parse({ q: '  Lee ' }).q).toBe('Lee')
    expect(listQuerySchema.parse({ q: '   ' }).q).toBeNull()
  })

  it('keeps wildcard characters as typed', () => {
    expect(listQuerySchema.parse({ q: '50%_off' }).q).toBe('50%_off')
  })

  it('parses offset and limit from query strings', () => {
    expect(listQuerySchema.parse({ offset: '50', limit: '100' })).toEqual({
      q: null,
      offset: 50,
      limit: 100,
    })
    expect(listQuerySchema.parse({ limit: '1' }).limit).toBe(1)
  })

  it.each([
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ q: ['a', 'b'] }, 'q'],
    [{ offset: '-1' }, 'offset'],
    [{ offset: '1.5' }, 'offset'],
    [{ offset: '' }, 'offset'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ limit: 'abc' }, 'limit'],
    [{ limit: '1e2' }, 'limit'],
  ])('rejects %j on %s', (input, field) => {
    expect(issuePath(input)).toEqual([field])
  })

  it('accepts a q of exactly 100 characters', () => {
    expect(listQuerySchema.parse({ q: 'x'.repeat(100) }).q).toHaveLength(100)
  })
})

describe('pageSchema', () => {
  it('validates a page envelope', () => {
    const schema = pageSchema(productDtoSchema)
    expect(
      schema.safeParse({ items: [], total: 0, offset: 0, limit: 25 }).success,
    ).toBe(true)
    expect(
      schema.safeParse({ items: [], total: -1, offset: 0, limit: 25 }).success,
    ).toBe(false)
  })
})

describe('listOrdersQuerySchema', () => {
  it('parses the awaiting-payment page query', () => {
    expect(
      listOrdersQuerySchema.parse({
        status: 'pending_payment',
        offset: '25',
        limit: '25',
      }),
    ).toEqual({ status: 'pending_payment', offset: 25, limit: 25 })
  })

  it('keeps the plain patient filter working', () => {
    expect(listOrdersQuerySchema.parse({ patientId: '7' })).toEqual({
      patientId: 7,
      offset: 0,
      limit: 25,
    })
  })

  it.each(['draft', 'pending_payment', 'paid', 'cancelled', 'all'])(
    'accepts status %s (revision 8)',
    (status) => {
      expect(listOrdersQuerySchema.parse({ status }).status).toBe(status)
    },
  )

  it.each([
    [{ status: 'bogus' }, 'status'],
    [{ status: 'PAID' }, 'status'],
    [{ status: 'pending_payment', limit: '0' }, 'limit'],
  ])('rejects %j on %s', (input, field) => {
    const result = listOrdersQuerySchema.safeParse(input)
    expect(result.error?.issues[0]?.path).toEqual([field])
  })
})

describe('listPatientsQuerySchema', () => {
  it('combines search, paging and the latest-status filter', () => {
    expect(
      listPatientsQuerySchema.parse({ q: ' lee ', latestStatus: 'none' }),
    ).toEqual({ q: 'lee', offset: 0, limit: 25, latestStatus: 'none' })
  })

  it.each(['none', 'draft', 'pending_payment', 'paid', 'cancelled'])(
    'accepts latestStatus %s',
    (latestStatus) => {
      expect(listPatientsQuerySchema.parse({ latestStatus }).latestStatus).toBe(
        latestStatus,
      )
    },
  )

  it.each(['all', 'any', ''])('rejects latestStatus %j', (latestStatus) => {
    const result = listPatientsQuerySchema.safeParse({ latestStatus })
    expect(result.error?.issues[0]?.path).toEqual(['latestStatus'])
  })
})
