import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { SignInOptionDto } from '@supplement-orders/domain'
import { renderWithRouter } from '../test/renderWithRouter'
import LoginView from './LoginView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getCurrentUser: vi.fn(), listSignInOptions: vi.fn() }
})

const curated: SignInOptionDto[] = [
  { id: 1, name: 'Dr. Maya Rivera', role: 'provider' },
  { id: 2, name: 'Jordan Lee', role: 'patient' },
  { id: 3, name: 'Ada Admin', role: 'admin' },
]

beforeEach(() => {
  vi.mocked(api.listSignInOptions).mockReset().mockResolvedValue(curated)
  vi.mocked(api.getCurrentUser).mockReset()
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
    expect(api.getCurrentUser).not.toHaveBeenCalled()
  })
})
