import { describe, expect, it } from 'vitest'
import { generatePatients } from './seed-bulk'

describe('generatePatients', () => {
  it('gives every patient a unique full name', () => {
    const names = generatePatients(246).map((p) => p.name)

    expect(new Set(names).size).toBe(names.length)
  })

  it('is deterministic', () => {
    expect(generatePatients(246)).toEqual(generatePatients(246))
  })

  it('refuses more patients than there are unique name combinations', () => {
    expect(() => generatePatients(501)).toThrow()
  })
})
