import type {
  DashboardDto,
  PatientDto,
  PatientOrderDetailDto,
  PatientOrderSummaryDto,
  PatientPageDto,
  ProductDto,
  ProductPageDto,
  ProviderOrderDetailDto,
  ProviderOrderSummaryDto,
  UserDto,
} from '@supplement-orders/domain'
import { render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import PrimeVue from 'primevue/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import * as api from '../api'
import App from '../App.vue'
import { primeVueOptions } from '../primevue'
import { createAppRouter } from '../router'
import { renderWithRouter } from '../test/renderWithRouter'
import { clearNoticeUnlessOn, useCurrentUser } from '../user'
import DashboardView from '../views/DashboardView.vue'
import MyOrdersView from '../views/MyOrdersView.vue'
import OrderBuilderView from '../views/OrderBuilderView.vue'
import PatientDetailView from '../views/PatientDetailView.vue'
import PatientOrderView from '../views/PatientOrderView.vue'
import PatientsView from '../views/PatientsView.vue'
import ProviderOrderView from '../views/ProviderOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    listUsers: vi.fn(),
    searchPatients: vi.fn(),
    getPatient: vi.fn(),
    listOrders: vi.fn(),
    searchProducts: vi.fn(),
    getOrder: vi.fn(),
    getDashboard: vi.fn(),
    listAwaitingPayment: vi.fn(),
  }
})

const LOADING = 'Loading…'

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
    patientId: 7,
  },
]

const patient: PatientDto = {
  id: 7,
  userId: 2,
  providerId: 1,
  name: 'Jordan Lee',
  dateOfBirth: '1984-03-14',
  address: '214 Alder St, Portland, OR 97205',
  orderCount: 1,
  latestOrderStatus: 'paid',
}

const vitamin: ProductDto = {
  id: 1,
  sku: 'VITD',
  name: 'Vitamin D3',
  cogsCents: 1200,
  stockQuantity: 10,
}

const patientsPage: PatientPageDto = {
  items: [patient],
  total: 1,
  offset: 0,
  limit: 25,
}

const noPatients: PatientPageDto = {
  items: [],
  total: 0,
  offset: 0,
  limit: 25,
}

const productsPage: ProductPageDto = {
  items: [vitamin],
  total: 1,
  offset: 0,
  limit: 25,
}

const noProducts: ProductPageDto = {
  items: [],
  total: 0,
  offset: 0,
  limit: 25,
}

const paidSplit = {
  subtotalCents: 2000,
  platformFeeCents: 15,
  totalCents: 2000,
  cogsCents: 1200,
  providerMarginCents: 785,
}

const providerSummary: ProviderOrderSummaryDto = {
  id: 7,
  view: 'provider',
  status: 'paid',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: '2026-10-05T12:10:00.000Z',
  cancelledAt: null,
  split: paidSplit,
}

const providerOrder: ProviderOrderDetailDto = {
  ...providerSummary,
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St, Portland, OR 97205',
  lines: [
    {
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 1,
      unitPriceCents: 2000,
      lineTotalCents: 2000,
      unitCogsCents: 1200,
      markupBps: 4000,
      minUnitPriceCents: 1210,
      stockQuantity: 9,
    },
  ],
  payment: {
    id: 5,
    amountCents: 2000,
    reference: 'fake_ch_123',
    createdAt: '2026-10-05T12:10:00.000Z',
  },
  ledger: [
    {
      id: 1,
      type: 'cogs',
      amountCents: 1200,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
    {
      id: 2,
      type: 'provider_margin',
      amountCents: 785,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
    {
      id: 3,
      type: 'platform_fee',
      amountCents: 15,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
  ],
}

const emptyDraft: ProviderOrderDetailDto = {
  ...providerOrder,
  status: 'draft',
  sentAt: null,
  paidAt: null,
  split: null,
  lines: [],
  payment: null,
  ledger: [],
}

const draftWithLine: ProviderOrderDetailDto = {
  ...emptyDraft,
  lines: providerOrder.lines,
}

const patientOrder: PatientOrderDetailDto = {
  id: 42,
  view: 'patient',
  status: 'pending_payment',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: null,
  cancelledAt: null,
  patientAddress: '214 Alder St, Portland, OR 97205',
  totalCents: 12000,
  lines: [
    {
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 3,
      unitPriceCents: 4000,
      lineTotalCents: 12000,
    },
  ],
  payment: null,
}

const myOrder: PatientOrderSummaryDto = {
  id: 11,
  view: 'patient',
  status: 'pending_payment',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:00:00.000Z',
  paidAt: null,
  cancelledAt: null,
  totalCents: 12000,
}

const dashboard: DashboardDto = {
  gmvCents: 6951,
  providerMarginCents: 3499,
  platformFeeCents: 52,
  paidOrders: [
    {
      orderId: 7,
      patientId: 7,
      patientName: 'Jordan Lee',
      paidAt: '2026-10-05T12:00:00.000Z',
      totalCents: 6951,
      cogsCents: 3400,
      providerMarginCents: 3499,
      platformFeeCents: 52,
    },
  ],
}

const emptyDashboard: DashboardDto = {
  gmvCents: 0,
  providerMarginCents: 0,
  platformFeeCents: 0,
  paidOrders: [],
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  const settled: Deferred<T> = {
    promise: Promise.resolve(undefined as T),
    resolve: () => {},
    reject: () => {},
  }
  const promise = new Promise<T>((resolve, reject) => {
    settled.resolve = resolve
    settled.reject = reject
  })
  settled.promise = promise
  return settled
}

function serverError(message: string) {
  return new api.ApiRequestError(500, 'INTERNAL', message)
}

async function expectLoading() {
  expect(await screen.findByText(LOADING)).toBeInTheDocument()
}

async function expectServerError(message: string) {
  expect(await screen.findByText(message)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
}

async function retry() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
}

function expectBannerGone(message: string) {
  expect(screen.queryByText(message)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument()
}

// Persona redirects and the unknown-user handoff live on the app router.
// The view helper installs a stub router, so these cases render App.
async function renderApp(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  render(App, { global: { plugins: [router, [PrimeVue, primeVueOptions]] } })
  return router
}

beforeEach(() => {
  vi.mocked(api.listUsers).mockReset().mockResolvedValue(users)
  vi.mocked(api.searchPatients).mockReset().mockResolvedValue(patientsPage)
  vi.mocked(api.getPatient).mockReset().mockResolvedValue(patient)
  vi.mocked(api.listOrders).mockReset().mockResolvedValue([providerSummary])
  vi.mocked(api.searchProducts).mockReset().mockResolvedValue(productsPage)
  vi.mocked(api.getOrder).mockReset().mockResolvedValue(providerOrder)
  vi.mocked(api.getDashboard).mockReset().mockResolvedValue(dashboard)
  vi.mocked(api.listAwaitingPayment)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 25 })
  useCurrentUser().signOut()
  clearNoticeUnlessOn('__reset__')
})

describe('PatientsView states', () => {
  it('shows Loading… while the patient list is pending', async () => {
    const pending = deferred<PatientPageDto>()
    vi.mocked(api.searchPatients).mockReturnValue(pending.promise)

    await renderWithRouter(PatientsView, { path: '/patients' })

    await expectLoading()
    expect(screen.queryByText('Jordan Lee')).not.toBeInTheDocument()

    pending.resolve(patientsPage)
    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the server message, and Retry loads the list', async () => {
    const message = 'Patient list unavailable'
    vi.mocked(api.searchPatients).mockRejectedValueOnce(serverError(message))
    await renderWithRouter(PatientsView, { path: '/patients' })
    await expectServerError(message)

    vi.mocked(api.searchPatients).mockResolvedValueOnce(patientsPage)
    await retry()

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.searchPatients).toHaveBeenCalledTimes(2)
  })

  it('shows the empty copy when no patients are returned', async () => {
    vi.mocked(api.searchPatients).mockResolvedValue(noPatients)
    await renderWithRouter(PatientsView, { path: '/patients' })
    expect(await screen.findByText('No patients yet.')).toBeInTheDocument()
  })
})

describe('PatientDetailView states', () => {
  async function renderDetail() {
    return renderWithRouter(PatientDetailView, {
      path: '/patients/7',
      props: { patientId: '7' },
    })
  }

  it('shows Loading… while the patient and orders are pending', async () => {
    const patientPending = deferred<PatientDto>()
    const ordersPending = deferred<ProviderOrderSummaryDto[]>()
    vi.mocked(api.getPatient).mockReturnValue(patientPending.promise)
    vi.mocked(api.listOrders).mockReturnValue(ordersPending.promise)

    await renderDetail()

    await expectLoading()
    expect(
      screen.queryByRole('heading', { name: 'Jordan Lee' }),
    ).not.toBeInTheDocument()

    patientPending.resolve(patient)
    ordersPending.resolve([providerSummary])
    expect(
      await screen.findByRole('heading', { name: 'Jordan Lee' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the server message, and Retry loads the patient', async () => {
    const message = 'Patient record unavailable'
    vi.mocked(api.getPatient).mockRejectedValueOnce(serverError(message))
    await renderDetail()
    await expectServerError(message)

    vi.mocked(api.getPatient).mockResolvedValueOnce(patient)
    vi.mocked(api.listOrders).mockResolvedValueOnce([providerSummary])
    await retry()

    expect(
      await screen.findByRole('heading', { name: 'Jordan Lee' }),
    ).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.getPatient).toHaveBeenCalledTimes(2)
    expect(api.listOrders).toHaveBeenCalledTimes(2)
  })

  it('shows the empty copy when the patient has no orders', async () => {
    vi.mocked(api.listOrders).mockResolvedValue([])
    await renderDetail()
    expect(
      await screen.findByText('No orders for this patient yet.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Jordan Lee' }),
    ).toBeInTheDocument()
  })
})

describe('OrderBuilderView states', () => {
  async function renderDraft() {
    return renderWithRouter(OrderBuilderView, {
      path: '/patients/7/orders/new',
      props: { patientId: '7', orderId: '99' },
    })
  }

  it('shows Loading… while an existing draft is pending', async () => {
    const patientPending = deferred<PatientDto>()
    const orderPending = deferred<ProviderOrderDetailDto>()
    vi.mocked(api.getPatient).mockReturnValue(patientPending.promise)
    vi.mocked(api.getOrder).mockReturnValue(orderPending.promise)

    await renderDraft()

    await expectLoading()
    expect(
      screen.queryByRole('heading', { name: /Draft order/ }),
    ).not.toBeInTheDocument()

    patientPending.resolve(patient)
    orderPending.resolve(emptyDraft)
    expect(
      await screen.findByRole('heading', { name: /Draft order #99/ }),
    ).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the server message, and Retry loads the draft', async () => {
    const message = 'Draft unavailable'
    vi.mocked(api.getOrder).mockRejectedValueOnce(serverError(message))
    await renderDraft()
    await expectServerError(message)

    vi.mocked(api.getPatient).mockResolvedValueOnce(patient)
    vi.mocked(api.getOrder).mockResolvedValueOnce(draftWithLine)
    await retry()

    expect(await screen.findByText('Vitamin D3')).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.getPatient).toHaveBeenCalledTimes(2)
    expect(api.getOrder).toHaveBeenCalledTimes(2)
  })

  it('shows the empty copy when the draft has no lines', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(emptyDraft)
    await renderDraft()
    expect(
      await screen.findByText('No lines yet. Add a product to start.'),
    ).toBeInTheDocument()
  })
})

describe('ProviderOrderView states', () => {
  async function renderOrder() {
    return renderWithRouter(ProviderOrderView, {
      path: '/orders/7',
      props: { orderId: '7' },
    })
  }

  it('shows Loading… while the order is pending', async () => {
    const pending = deferred<ProviderOrderDetailDto>()
    vi.mocked(api.getOrder).mockReturnValue(pending.promise)

    await renderOrder()

    await expectLoading()
    expect(
      screen.queryByRole('heading', { name: /Order #7/ }),
    ).not.toBeInTheDocument()

    pending.resolve(providerOrder)
    expect(
      await screen.findByRole('heading', { name: /Order #7/ }),
    ).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the server message, and Retry loads the order', async () => {
    const message = 'Order unavailable'
    vi.mocked(api.getOrder).mockRejectedValueOnce(serverError(message))
    await renderOrder()
    await expectServerError(message)

    vi.mocked(api.getOrder).mockResolvedValueOnce(providerOrder)
    await retry()

    expect(
      await screen.findByRole('heading', { name: /Order #7/ }),
    ).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.getOrder).toHaveBeenCalledTimes(2)
  })
})

describe('DashboardView states', () => {
  async function renderDashboard() {
    return renderWithRouter(DashboardView, { path: '/dashboard' })
  }

  it('shows Loading… for sales and for inventory while each is pending', async () => {
    const salesPending = deferred<DashboardDto>()
    const inventoryPending = deferred<ProductPageDto>()
    vi.mocked(api.getDashboard).mockReturnValue(salesPending.promise)
    vi.mocked(api.searchProducts).mockReturnValue(inventoryPending.promise)

    await renderDashboard()

    await vi.waitFor(() => {
      expect(screen.getAllByText(LOADING)).toHaveLength(2)
    })
    expect(screen.queryByText('GMV')).not.toBeInTheDocument()
    expect(screen.queryByText('Vitamin D3')).not.toBeInTheDocument()

    salesPending.resolve(dashboard)
    expect(await screen.findByText('GMV')).toBeInTheDocument()
    expect(screen.getAllByText(LOADING)).toHaveLength(1)

    inventoryPending.resolve(productsPage)
    expect(await screen.findByText('Vitamin D3')).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the sales server message, and Retry loads sales', async () => {
    const message = 'Sales unavailable'
    vi.mocked(api.getDashboard).mockRejectedValueOnce(serverError(message))
    vi.mocked(api.searchProducts).mockResolvedValue(productsPage)
    await renderDashboard()
    await expectServerError(message)
    expect(await screen.findByText('Vitamin D3')).toBeInTheDocument()

    vi.mocked(api.getDashboard).mockResolvedValueOnce(dashboard)
    await retry()

    expect(await screen.findByText('GMV')).toBeInTheDocument()
    expect(screen.getByText('Jordan Lee')).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.getDashboard).toHaveBeenCalledTimes(2)
  })

  it('shows the inventory server message, and Retry loads inventory', async () => {
    const message = 'Inventory unavailable'
    vi.mocked(api.searchProducts).mockRejectedValueOnce(serverError(message))
    vi.mocked(api.getDashboard).mockResolvedValue(dashboard)
    await renderDashboard()
    await expectServerError(message)
    expect(await screen.findByText('GMV')).toBeInTheDocument()

    vi.mocked(api.searchProducts).mockResolvedValueOnce(productsPage)
    await retry()

    expect(await screen.findByText('Vitamin D3')).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.searchProducts).toHaveBeenCalledTimes(2)
  })

  it('shows the empty copy for sales and for inventory', async () => {
    vi.mocked(api.getDashboard).mockResolvedValue(emptyDashboard)
    vi.mocked(api.searchProducts).mockResolvedValue(noProducts)
    await renderDashboard()
    expect(await screen.findByText('No paid orders yet.')).toBeInTheDocument()
    expect(screen.getByText('No products.')).toBeInTheDocument()
  })
})

describe('MyOrdersView states', () => {
  it('shows Loading… while orders are pending', async () => {
    const pending = deferred<PatientOrderSummaryDto[]>()
    vi.mocked(api.listOrders).mockReturnValue(pending.promise)

    await renderWithRouter(MyOrdersView, { path: '/my-orders' })

    await expectLoading()
    expect(screen.queryByText('Dr. Maya Rivera')).not.toBeInTheDocument()

    pending.resolve([myOrder])
    expect(await screen.findByText('Dr. Maya Rivera')).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the server message, and Retry loads the orders', async () => {
    const message = 'Orders unavailable'
    vi.mocked(api.listOrders).mockRejectedValueOnce(serverError(message))
    await renderWithRouter(MyOrdersView, { path: '/my-orders' })
    await expectServerError(message)

    vi.mocked(api.listOrders).mockResolvedValueOnce([myOrder])
    await retry()

    expect(await screen.findByText('Dr. Maya Rivera')).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.listOrders).toHaveBeenCalledTimes(2)
  })

  it('shows the empty copy when the patient has no orders', async () => {
    vi.mocked(api.listOrders).mockResolvedValue([])
    await renderWithRouter(MyOrdersView, { path: '/my-orders' })
    expect(
      await screen.findByText('You have no orders yet.'),
    ).toBeInTheDocument()
  })
})

describe('PatientOrderView states', () => {
  async function renderPay() {
    return renderWithRouter(PatientOrderView, {
      path: '/my-orders/42',
      props: { orderId: '42' },
    })
  }

  it('shows Loading… while the order is pending', async () => {
    const pending = deferred<PatientOrderDetailDto>()
    vi.mocked(api.getOrder).mockReturnValue(pending.promise)

    await renderPay()

    await expectLoading()
    expect(
      screen.queryByRole('heading', { name: /Order #42/ }),
    ).not.toBeInTheDocument()

    pending.resolve(patientOrder)
    expect(
      await screen.findByRole('heading', { name: /Order #42/ }),
    ).toBeInTheDocument()
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
  })

  it('shows the server message, and Retry loads the order', async () => {
    const message = 'This order is unavailable'
    vi.mocked(api.getOrder).mockRejectedValueOnce(serverError(message))
    await renderPay()
    await expectServerError(message)

    vi.mocked(api.getOrder).mockResolvedValueOnce(patientOrder)
    await retry()

    expect(
      await screen.findByRole('heading', { name: /Order #42/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pay $120.00' }),
    ).toBeInTheDocument()
    expectBannerGone(message)
    expect(api.getOrder).toHaveBeenCalledTimes(2)
  })
})

// renderApp returns the router, not Testing Library's render result.
/* eslint-disable testing-library/render-result-naming-convention */
describe('persona and unknown user', () => {
  it('sends a patient away from a provider route with a notice', async () => {
    useCurrentUser().signIn(2)
    const router = await renderApp('/patients')

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/my-orders'),
    )
    expect(
      await screen.findByText(
        'That page is for providers, so you were sent to your home page.',
      ),
    ).toBeInTheDocument()
  })

  it('sends a provider away from a patient route with a notice', async () => {
    useCurrentUser().signIn(1)
    const router = await renderApp('/my-orders')

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients'),
    )
    expect(
      await screen.findByText(
        'That page is for patients, so you were sent to your home page.',
      ),
    ).toBeInTheDocument()
  })

  it('sends the user to /login when the API rejects an unknown user', async () => {
    useCurrentUser().signIn(1)
    vi.mocked(api.searchPatients).mockRejectedValue(
      new api.ApiRequestError(401, 'UNAUTHENTICATED', 'Unknown user'),
    )
    const router = await renderApp('/patients')

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/login'),
    )
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
  })
})
/* eslint-enable testing-library/render-result-naming-convention */
