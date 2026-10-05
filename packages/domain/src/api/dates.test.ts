import { describe, expect, it } from 'vitest'
import { parseDateOfBirthQuery } from './dates'

describe('parseDateOfBirthQuery', () => {
  it.each([
    ['03/14/1985', '1985-03-14'],
    ['1985-03-14', '1985-03-14'],
    ['  12/31/1999 ', '1999-12-31'],
    ['02/29/2000', '2000-02-29'],
    ['2024-02-29', '2024-02-29'],
  ])('reads %s as %s', (q, iso) => {
    expect(parseDateOfBirthQuery(q)).toBe(iso)
  })

  it.each([
    '02/30/1990',
    '02/29/1900',
    '13/01/1990',
    '00/10/1990',
    '1990-04-31',
    '3/5/1990',
    '03-14-1985',
    '1985/03/14',
    '03/14/85',
    '03/14/1985 lee',
    'lee',
    '',
  ])('treats %j as name text', (q) => {
    expect(parseDateOfBirthQuery(q)).toBeNull()
  })
})
