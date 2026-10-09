import type {
  DashboardDto,
  ListPatientsQuery,
  PatientPageDto,
  ProductDto,
} from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import * as api from '../api'
import { atMinimum } from '../test/products'
import { renderWithRouter } from '../test/renderWithRouter'
import DashboardView from '../views/DashboardView.vue'
import PatientsView from '../views/PatientsView.vue'
import { useListUrl } from './useListUrl'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    searchPatients: vi.fn(),
    getDashboard: vi.fn(),
    searchProducts: vi.fn(),
  }
})

// Plain render-function components keep this file free of SFCs.
const Target = { render: () => h('p', 'Orders page') }

/** A lazy route component whose chunk "loads" only when the test says so. */
function slowChunk() {
  let resolve: () => void = () => {}
  const loaded = new Promise<typeof Target>((done) => {
    resolve = () => done(Target)
  })
  return { load: () => loaded, finish: () => resolve() }
}

function patientPage(query: ListPatientsQuery): PatientPageDto {
  return {
    items: [],
    total: query.q ? 0 : 312,
    offset: query.offset ?? 0,
    limit: 25,
  }
}

const dashboard: DashboardDto = {
  soldByProduct: [],
  range: {
    preset: 'month',
    from: '2026-10-01',
    to: '2026-10-07',
    timeZone: 'UTC',
  },
  gmvCents: 0,
  providerMarginCents: 0,
  platformFeeCents: 0,
  owedToYouCents: 0,
}

const product: ProductDto = atMinimum({
  id: 1,
  sku: 'VITD',
  name: 'Vitamin D3',
  cogsCents: 850,
  stockQuantity: 10,
})

beforeEach(() => {
  vi.mocked(api.searchPatients)
    .mockReset()
    .mockImplementation(async (query = {}) => patientPage(query))
  vi.mocked(api.getDashboard).mockReset().mockResolvedValue(dashboard)
  vi.mocked(api.searchProducts)
    .mockReset()
    .mockResolvedValue({ items: [product], total: 1, offset: 0, limit: 25 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('debounced list search vs. navigation', () => {
  it('Patients: a pending debounce never fires after leaving, and the push lands', async () => {
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    const chunk = slowChunk()
    router.addRoute({ path: '/orders', component: chunk.load })
    await screen.findByRole('searchbox', {
      name: 'Search by name or date of birth',
    })
    const replace = vi.spyOn(router, 'replace')
    vi.mocked(api.searchPatients).mockClear()

    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.type(
      screen.getByRole('searchbox', {
        name: 'Search by name or date of birth',
      }),
      'lee',
    )
    // The debounce is pending; the user navigates away while the target loads.
    const navigation = router.push('/orders')
    await vi.advanceTimersByTimeAsync(1000)
    chunk.finish()
    vi.useRealTimers()
    await navigation

    expect(router.currentRoute.value.fullPath).toBe('/orders')
    expect(replace).not.toHaveBeenCalled()
    expect(api.searchPatients).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'lee' }),
    )
  })

  it('Dashboard: typing in inventory search then following a link still arrives', async () => {
    const { router } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    const chunk = slowChunk()
    router.addRoute({ path: '/orders', component: chunk.load })
    await screen.findByText('Vitamin D3')
    const replace = vi.spyOn(router, 'replace')
    vi.mocked(api.searchProducts).mockClear()

    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.type(
      screen.getByRole('searchbox', { name: 'Search products' }),
      'vit',
    )
    await user.click(
      screen.getByRole('link', { name: 'See orders awaiting payment →' }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    chunk.finish()
    vi.useRealTimers()

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe(
        '/orders?status=pending_payment',
      ),
    )
    expect(replace).not.toHaveBeenCalled()
    expect(api.searchProducts).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'vit' }),
    )
  })

  it('replaceQuery does nothing while a navigation is in flight', async () => {
    let listUrl: ReturnType<typeof useListUrl> | undefined
    const List = {
      setup() {
        listUrl = useListUrl()
        return () => h('p', 'List')
      },
    }
    const { router } = await renderWithRouter(
      { render: () => h('div') },
      { path: '/list' },
    )
    const chunk = slowChunk()
    router.addRoute({ path: '/elsewhere', component: chunk.load })
    render(List, { global: { plugins: [router] } })
    const replace = vi.spyOn(router, 'replace')

    const navigation = router.push('/elsewhere')
    // Mid-navigation (guards ran, chunk still loading): a URL write must not
    // supersede it.
    await vi.waitFor(() => expect(listUrl?.isCurrent()).toBe(false))
    expect(listUrl?.replaceQuery({ q: 'late' })).toBeUndefined()
    chunk.finish()
    await navigation

    expect(replace).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/elsewhere')
  })
})
