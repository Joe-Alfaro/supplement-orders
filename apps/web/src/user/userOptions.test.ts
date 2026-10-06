import type { UserDto } from '@supplement-orders/domain'
import { describe, expect, it } from 'vitest'
import { userOptions } from './useCurrentUser'

const user = (id: number, name: string, role: UserDto['role']): UserDto => ({
  id,
  name,
  role,
  providerId: role === 'provider' ? id : null,
  patientId: role === 'patient' ? id : null,
})

describe('userOptions', () => {
  it('adds the user id only when names collide', () => {
    expect(
      userOptions([
        user(1, 'Dr. Maya Rivera', 'provider'),
        user(7, 'Avery Abbott', 'patient'),
        user(9, 'Avery Abbott', 'patient'),
      ]).map((option) => option.label),
    ).toEqual([
      'Dr. Maya Rivera (Provider)',
      'Avery Abbott (Patient) · user #7',
      'Avery Abbott (Patient) · user #9',
    ])
  })
})
