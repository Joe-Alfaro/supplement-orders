import { describe, expect, it } from 'vitest'
import { escapeLike } from './search'

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLike("O'Brien 12-B")).toBe("O'Brien 12-B")
  })
})
