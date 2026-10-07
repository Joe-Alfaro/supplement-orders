import type { UserDto } from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import * as api from '../api'
import PrimeVue from 'primevue/config'
import App from '../App.vue'
import { primeVueOptions } from '../primevue'
import { createAppRouter } from '../router'
import { useCurrentUser } from '../user'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    listUsers: vi.fn(),
    listSignInOptions: vi.fn(),
    searchPatients: vi.fn(),
    listOrders: vi.fn(),
    searchAdminProducts: vi.fn(),
  }
})

const users: UserDto[] = [
  {
    id: 1,
    name: 'Dr. Maya Rivera',
    role: 'provider',
    providerId: 1,
    patientId: null,
  },
  {
    id: 2,
    name: 'Jordan Lee',
    role: 'patient',
    providerId: null,
    patientId: 1,
  },
  {
    id: 3,
    name: 'Ada Admin',
    role: 'admin',
    providerId: null,
    patientId: null,
  },
]

/** Mounts the whole app at `path` with the real router guards; returns the router. */
async function startApp(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  render(App, { global: { plugins: [router, [PrimeVue, primeVueOptions]] } })
  return router
}

beforeEach(() => {
  vi.mocked(api.listUsers).mockResolvedValue(users)
  vi.mocked(api.listSignInOptions).mockResolvedValue(users)
  vi.mocked(api.searchPatients).mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    limit: 25,
  })
  vi.mocked(api.listOrders).mockResolvedValue([])
  vi.mocked(api.searchAdminProducts).mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    limit: 25,
  })
  useCurrentUser().signOut()
})

describe('stub login', () => {
  it('redirects signed-out navigation to /login with no header', async () => {
    const router = await startApp('/patients')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Authentication is stubbed/)).toBeInTheDocument()
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
  })

  it('signs in, stores the user, and lands on the persona home', async () => {
    const user = userEvent.setup()
    const router = await startApp('/login')

    await user.click(await screen.findByRole('combobox', { name: 'User' }))
    await user.click(
      await screen.findByRole('option', { name: 'Jordan Lee (Patient)' }),
    )
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders'),
    )
    expect(localStorage.getItem('supplementOrders.userId')).toBe('2')
    expect(
      await screen.findByText(/Signed in as Jordan Lee \(Patient\)/),
    ).toBeInTheDocument()
  })

  it('signs out, clearing the stored user', async () => {
    const user = userEvent.setup()
    useCurrentUser().signIn(1)
    const router = await startApp('/')
    expect(router.currentRoute.value.path).toBe('/patients')

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/login'),
    )
    expect(localStorage.getItem('supplementOrders.userId')).toBeNull()
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
  })

  it('shows the provider tabs Patients, Orders, Dashboard in order', async () => {
    useCurrentUser().signIn(1)
    await startApp('/')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Patients', 'Orders', 'Dashboard'])
  })
})

describe('admin persona', () => {
  it('lists the admin on the login screen and lands on /admin/inventory', async () => {
    const user = userEvent.setup()
    const router = await startApp('/login')

    await user.click(await screen.findByRole('combobox', { name: 'User' }))
    await user.click(
      await screen.findByRole('option', { name: 'Ada Admin (Admin)' }),
    )
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/admin/inventory'),
    )
    expect(localStorage.getItem('supplementOrders.userId')).toBe('3')
  })

  it('shows only the Inventory tab, her name and Sign out', async () => {
    useCurrentUser().signIn(3)
    await startApp('/')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Inventory'])
    expect(screen.getByText(/Signed in as Ada Admin/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it.each(['/patients', '/patients/1', '/orders', '/dashboard', '/my-orders'])(
    'sends an admin visiting %s to her home',
    async (path) => {
      useCurrentUser().signIn(3)
      const router = await startApp(path)

      expect(router.currentRoute.value.path).toBe('/admin/inventory')
    },
  )

  it.each([1, 2])(
    'sends user %i away from /admin/inventory to their home',
    async (id) => {
      useCurrentUser().signIn(id)
      const router = await startApp('/admin/inventory')

      expect(router.currentRoute.value.path).toBe(
        id === 1 ? '/patients' : '/my-orders',
      )
    },
  )

  it('sends a signed-out visitor of /admin/inventory to login', async () => {
    const router = await startApp('/admin/inventory')

    expect(router.currentRoute.value.path).toBe('/login')
  })
})
