import type { Role } from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import ToastService from 'primevue/toastservice'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import { primeVueOptions } from '../primevue'
import { createAppRouter } from '../router'
import { useCurrentUser } from '../user'

interface Persona {
  id: number
  name: string
  role: Role
  home: string
}

const personas: Persona[] = [
  { id: 1, name: 'Dr. Maya Rivera', role: 'provider', home: '/patients' },
  { id: 2, name: 'Jordan Lee', role: 'patient', home: '/my-orders' },
  { id: 3, name: 'Ada Admin', role: 'admin', home: '/admin/inventory' },
]

const emptyPage = { items: [], total: 0, offset: 0, limit: 25 }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function unauthenticated() {
  return json(
    { error: { code: 'UNAUTHENTICATED', message: 'Unknown user' } },
    401,
  )
}

const requested: string[] = []

/** A fake API: /me answers from the X-User-Id header; lists are empty. */
function fakeApi(input: RequestInfo | URL, init?: RequestInit) {
  const path = String(input)
  requested.push(path)
  const headers = new Headers(init?.headers)
  if (path === '/api/users/sign-in-options') {
    return Promise.resolve(
      json(personas.map(({ id, name, role }) => ({ id, name, role }))),
    )
  }
  if (path === '/api/users/me') {
    const persona = personas.find(
      (candidate) => String(candidate.id) === headers.get('X-User-Id'),
    )
    return Promise.resolve(
      persona
        ? json({ id: persona.id, name: persona.name, role: persona.role })
        : unauthenticated(),
    )
  }
  return Promise.resolve(
    path.includes('?') || path.endsWith('s') ? json(emptyPage) : json([]),
  )
}

async function startApp(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  render(App, {
    global: { plugins: [router, [PrimeVue, primeVueOptions], ToastService] },
  })
  return router
}

beforeEach(() => {
  requested.length = 0
  useCurrentUser().signOut()
  vi.stubGlobal('fetch', vi.fn(fakeApi))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function directoryRequests() {
  return requested.filter((path) => path === '/api/users')
}

describe('session restore through /api/users/me', () => {
  it.each(personas)(
    'restores the $role session from /me and shows the header',
    async ({ id, name, home }) => {
      useCurrentUser().signIn(id)
      const router = await startApp('/')

      expect(router.currentRoute.value.path).toBe(home)
      expect(
        await screen.findByText(new RegExp(`Signed in as ${name}`)),
      ).toBeInTheDocument()
      expect(requested).toContain('/api/users/me')
      expect(directoryRequests()).toEqual([])
    },
  )

  it('goes to login without calling /me when nobody is signed in', async () => {
    const router = await startApp('/patients')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(requested).not.toContain('/api/users/me')
    expect(directoryRequests()).toEqual([])
  })

  it('treats a 401 from /me as signed out and returns to login', async () => {
    useCurrentUser().signIn(99)
    const router = await startApp('/patients')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(localStorage.getItem('supplementOrders.userId')).toBeNull()
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
  })

  it('returns to login when a later request is rejected with 401', async () => {
    useCurrentUser().signIn(1)
    const router = await startApp('/patients')
    await screen.findByText(/Signed in as Dr. Maya Rivera/)
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(unauthenticated()),
    )

    await router.push('/orders')
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/login'),
    )
    expect(localStorage.getItem('supplementOrders.userId')).toBeNull()
  })

  it('signs in from the curated list without ever loading the directory', async () => {
    const actor = userEvent.setup()
    const router = await startApp('/login')

    await actor.click(await screen.findByRole('combobox', { name: 'User' }))
    await actor.click(
      await screen.findByRole('option', { name: 'Jordan Lee (Patient)' }),
    )
    await actor.click(screen.getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders'),
    )
    expect(
      await screen.findByText(/Signed in as Jordan Lee \(Patient\)/),
    ).toBeInTheDocument()
    expect(directoryRequests()).toEqual([])
  })
})
