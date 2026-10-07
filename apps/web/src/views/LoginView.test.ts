import type { UserDto } from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import LoginView from './LoginView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, listUsers: vi.fn(), listSignInOptions: vi.fn() }
})

function user(
  id: number,
  name: string,
  role: UserDto['role'],
  ids: Partial<UserDto> = {},
): UserDto {
  return { id, name, role, providerId: null, patientId: null, ...ids }
}

const curated: UserDto[] = [
  user(1, 'Dr. Maya Rivera', 'provider', { providerId: 1 }),
  user(2, 'Jordan Lee', 'patient', { patientId: 1 }),
  user(3, 'Ada Admin', 'admin'),
]

beforeEach(() => {
  vi.mocked(api.listSignInOptions).mockReset().mockResolvedValue(curated)
  vi.mocked(api.listUsers)
    .mockReset()
    .mockResolvedValue([...curated, user(9, 'Hidden Patient', 'patient')])
})

describe('LoginView', () => {
  it('lists exactly the curated options, in order, with no search box', async () => {
    const actor = userEvent.setup()
    await renderWithRouter(LoginView, { path: '/login' })

    await actor.click(await screen.findByRole('combobox', { name: 'User' }))

    expect(
      (await screen.findAllByRole('option')).map(
        (option) => option.textContent,
      ),
    ).toEqual([
      'Dr. Maya Rivera (Provider)',
      'Jordan Lee (Patient)',
      'Ada Admin (Admin)',
    ])
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText('Search users'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
