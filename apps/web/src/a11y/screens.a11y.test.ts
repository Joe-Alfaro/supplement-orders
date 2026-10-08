import type {
  DashboardDto,
  ListQuery,
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
import { screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type {
  AdminAccountsDto,
  AdminJournalDto,
  ProviderOrderJournalDto,
} from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import { useCurrentUser } from '../user'
import AdminAccountsView from '../views/AdminAccountsView.vue'
import AdminInventoryView from '../views/AdminInventoryView.vue'
import DashboardView from '../views/DashboardView.vue'
import LoginView from '../views/LoginView.vue'
import MyOrdersView from '../views/MyOrdersView.vue'
import OrderBuilderView from '../views/OrderBuilderView.vue'
import PatientDetailView from '../views/PatientDetailView.vue'
import PatientOrderView from '../views/PatientOrderView.vue'
import PatientsView from '../views/PatientsView.vue'
import ProviderOrderView from '../views/ProviderOrderView.vue'
import { expectNoAxeViolations } from './expectNoAxeViolations'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    listUsers: vi.fn(),
    listSignInOptions: vi.fn(),
    searchPatients: vi.fn(),
    getPatient: vi.fn(),
    listOrders: vi.fn(),
    searchProducts: vi.fn(),
    getOrder: vi.fn(),
    createOrder: vi.fn(),
    replaceOrderLines: vi.fn(),
    sendOrder: vi.fn(),
    payOrder: vi.fn(),
    getDashboard: vi.fn(),
    searchAdminProducts: vi.fn(),
    getAdminAccounts: vi.fn(),
    listAdminJournals: vi.fn(),
    setProductStock: vi.fn(),
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

const products: ProductDto[] = [
  {
    id: 1,
    sku: 'VITD',
    name: 'Vitamin D3',
    cogsCents: 1200,
    stockQuantity: 10,
  },
  { id: 2, sku: 'MAG', name: 'Magnesium', cogsCents: 1500, stockQuantity: 5 },
  { id: 3, sku: 'ZINC', name: 'Zinc', cogsCents: 500, stockQuantity: 0 },
]

const paidSplit = {
  subtotalCents: 2000,
  platformFeeCents: 15,
  totalCents: 2000,
  cogsCents: 1200,
  providerMarginCents: 785,
}

const providerSummary: ProviderOrderSummaryDto = {
  splitFromOrderId: null,
  backorderOrderId: null,
  blockedByOrderId: null,
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
  revision: 1,
  split: paidSplit,
}

const paidProviderOrder: ProviderOrderJournalDto = {
  partialPaymentQuote: null,
  paymentInProgress: null,
  backorderStatus: null,
  ...providerSummary,
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St, Portland, OR 97205',
  lines: [
    {
      payableQuantity: null,
      shortQuantity: null,
      lineId: 902,
      availableQuantity: null,
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
  ledger: [],
  journal: {
    id: 9,
    postedAt: '2026-10-05T12:10:00.000Z',
    memo: 'Payment for order #7',
    postings: [
      {
        accountCode: '1000',
        accountName: 'Cash',
        debitCents: 2000,
        creditCents: null,
      },
      {
        accountCode: '4000',
        accountName: 'Product sales at wholesale cost',
        debitCents: null,
        creditCents: 1200,
      },
      {
        accountCode: '2100-1',
        accountName: 'Payable to Dr. Maya Rivera',
        debitCents: null,
        creditCents: 785,
      },
      {
        accountCode: '4100',
        accountName: 'Platform fee revenue',
        debitCents: null,
        creditCents: 15,
      },
    ],
  },
}

const emptyDraft: ProviderOrderDetailDto = {
  ...paidProviderOrder,
  status: 'draft',
  sentAt: null,
  paidAt: null,
  revision: 0,
  split: null,
  lines: [],
  payment: null,
  ledger: [],
}

const pendingPatientOrder: PatientOrderDetailDto = {
  partialPaymentQuote: null,
  paymentInProgress: null,
  backorderStatus: null,
  splitFromOrderId: null,
  backorderOrderId: null,
  blockedByOrderId: null,
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
  revision: 1,
  patientAddress: '214 Alder St, Portland, OR 97205',
  totalCents: 12000,
  lines: [
    {
      payableQuantity: null,
      shortQuantity: null,
      lineId: 901,
      availableQuantity: null,
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

const paidPatientOrder: PatientOrderDetailDto = {
  ...pendingPatientOrder,
  status: 'paid',
  paidAt: '2026-10-05T12:10:00.000Z',
  payment: {
    id: 5,
    amountCents: 12000,
    reference: 'fake_ch_123',
    createdAt: '2026-10-05T12:10:00.000Z',
  },
}

const myOrders: PatientOrderSummaryDto[] = [
  {
    splitFromOrderId: null,
    backorderOrderId: null,
    blockedByOrderId: null,
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
    revision: 1,
    totalCents: 12000,
  },
]

const dashboard: DashboardDto & { owedToYouCents: number } = {
  owedToYouCents: 785,
  gmvCents: 6951,
  providerMarginCents: 3499,
  platformFeeCents: 52,
  range: {
    preset: 'month',
    from: '2026-10-01',
    to: '2026-10-07',
    timeZone: 'UTC',
  },
}

function productPage(query: ListQuery): ProductPageDto {
  const q = query.q?.toLowerCase() ?? ''
  const items = products.filter(
    (product) =>
      product.name.toLowerCase().includes(q) ||
      product.sku.toLowerCase().includes(q),
  )
  return { items, total: items.length, offset: 0, limit: query.limit ?? 25 }
}

function patientPage(query: ListQuery): PatientPageDto {
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  if (query.q === 'nobody') return { items: [], total: 0, offset, limit }
  return { items: [patient], total: 1, offset, limit }
}

beforeEach(async () => {
  vi.mocked(api.listUsers).mockResolvedValue(users)
  vi.mocked(api.listSignInOptions).mockResolvedValue(users)
  vi.mocked(api.searchPatients).mockImplementation(async (query = {}) =>
    patientPage(query),
  )
  vi.mocked(api.getPatient).mockResolvedValue(patient)
  vi.mocked(api.listOrders).mockResolvedValue([providerSummary])
  vi.mocked(api.searchProducts).mockImplementation(async (query = {}) =>
    productPage(query),
  )
  vi.mocked(api.getOrder).mockResolvedValue(paidProviderOrder)
  vi.mocked(api.createOrder).mockResolvedValue(emptyDraft)
  vi.mocked(api.replaceOrderLines).mockResolvedValue(emptyDraft)
  vi.mocked(api.sendOrder).mockResolvedValue(paidProviderOrder)
  vi.mocked(api.payOrder).mockResolvedValue(paidPatientOrder)
  vi.mocked(api.getDashboard).mockResolvedValue(dashboard)
  vi.mocked(api.getAdminAccounts).mockResolvedValue(trialBalance)
  vi.mocked(api.listAdminJournals).mockResolvedValue({
    items: [adminJournal],
    total: 1,
    offset: 0,
    limit: 25,
  })
  vi.mocked(api.searchAdminProducts).mockResolvedValue({
    items: [
      { id: 1, name: 'Vitamin D3', wholesaleCostCents: 850, stockQuantity: 40 },
    ],
    total: 1,
    offset: 0,
    limit: 25,
  })
  useCurrentUser().signOut()
  await useCurrentUser().ensureUsersLoaded()
})

async function renderBuilder() {
  const view = await renderWithRouter(OrderBuilderView, {
    path: '/patients/7/orders/new',
    props: { patientId: '7', orderId: 'new' },
  })
  await screen.findByRole('heading', { name: /New order/ })
  return view
}

async function replaceInput(
  user: UserEvent,
  field: HTMLElement,
  value: string,
) {
  await user.clear(field)
  await user.type(field, value)
}

async function chooseProduct(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: 'Add line' }))
  await screen.findByRole('heading', { name: 'Add product: choose a product' })
  await user.click(await screen.findByText(name))
  await screen.findByRole('heading', { name: `Add ${name}` })
}

async function addProduct(user: UserEvent, name: string, price?: string) {
  await chooseProduct(user, name)
  if (price !== undefined) {
    await replaceInput(
      user,
      screen.getByLabelText('Patient price (each)'),
      price,
    )
  }
  await user.click(screen.getByRole('button', { name: 'Add to order' }))
  await screen.findByRole('textbox', {
    name: new RegExp('^Qty ' + name),
  })
}

// PrimeVue Dialog teleports to document.body. A Select list does too, unless
// the component appends it to itself (the login picker does). Any dialog or
// listbox outside the render container is scanned on its own element, with the
// same axe rules.
async function scanUncontained(container: Element, role: 'dialog' | 'listbox') {
  const outside = screen
    .queryAllByRole(role)
    .filter((node) => !container.contains(node))
  await outside.reduce(async (previous, node) => {
    await previous
    await expectNoAxeViolations(node)
  }, Promise.resolve())
}

async function expectAccessible(container: Element) {
  await expectNoAxeViolations(container)
  await scanUncontained(container, 'dialog')
  await scanUncontained(container, 'listbox')
}

const trialBalance: AdminAccountsDto = {
  accounts: [
    {
      id: 1,
      code: '1000',
      name: 'Cash',
      type: 'asset',
      debitsCents: 2000,
      creditsCents: 0,
      balanceCents: 2000,
    },
    {
      id: 2,
      code: '4000',
      name: 'Product sales at wholesale cost',
      type: 'revenue',
      debitsCents: 0,
      creditsCents: 2000,
      balanceCents: 2000,
    },
  ],
  totals: { debitsCents: 2000, creditsCents: 2000 },
}

const adminJournal: AdminJournalDto = {
  id: 9,
  orderId: 7,
  memo: 'Payment for order #7',
  postedAt: '2026-10-05T12:10:00.000Z',
  patientName: 'Jordan Lee',
  providerName: 'Dr. Maya Rivera',
  postings: [
    {
      accountCode: '1000',
      accountName: 'Cash',
      debitCents: 2000,
      creditCents: null,
    },
    {
      accountCode: '4000',
      accountName: 'Product sales at wholesale cost',
      debitCents: null,
      creditCents: 2000,
    },
  ],
}

describe('accessibility', () => {
  it('admin accounts: trial balance and journals', async () => {
    const { container } = await renderWithRouter(AdminAccountsView, {
      path: '/admin/accounts',
    })
    await screen.findByRole('table', { name: 'Trial balance' })
    await screen.findByRole('table', { name: 'Journals' })
    await expectAccessible(container)
  })

  it('admin accounts with an expanded journal', async () => {
    const { container } = await renderWithRouter(AdminAccountsView, {
      path: '/admin/accounts',
    })
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: 'Show postings for journal 9',
      }),
    )
    await screen.findByRole('table', { name: 'Journal 9 postings' })
    await expectAccessible(container)
  })

  it('admin inventory', async () => {
    const { container } = await renderWithRouter(AdminInventoryView, {
      path: '/admin/inventory',
    })
    await screen.findByRole('spinbutton', { name: 'Stock for Vitamin D3' })
    await expectAccessible(container)
  })

  it('admin inventory with an unsaved edit and a conflict', async () => {
    vi.mocked(api.setProductStock).mockRejectedValue(
      new api.ApiRequestError(409, 'STOCK_CHANGED', 'Changed', undefined, 33),
    )
    const { container } = await renderWithRouter(AdminInventoryView, {
      path: '/admin/inventory',
    })
    const user = userEvent.setup()
    const input = await screen.findByRole('spinbutton', {
      name: 'Stock for Vitamin D3',
    })
    await user.click(input)
    ;(input as HTMLInputElement).select()
    await user.keyboard('55{Enter}')
    await screen.findByRole('alert')
    await expectAccessible(container)
  })

  it('login', async () => {
    const user = userEvent.setup()
    const { container } = await renderWithRouter(LoginView, { path: '/login' })
    await screen.findByRole('heading', { name: 'Sign in' })
    await user.click(await screen.findByRole('combobox', { name: 'User' }))
    expect(
      await screen.findByRole('option', { name: /Dr. Maya Rivera/ }),
    ).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('patient list results', async () => {
    const { container } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    await screen.findByText('Jordan Lee')
    await expectAccessible(container)
  })

  it('patient list no matches', async () => {
    const { container } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    await screen.findByText('Jordan Lee')
    const user = userEvent.setup()
    await user.type(
      screen.getByLabelText('Search by name or date of birth'),
      'nobody',
    )
    await screen.findByText(/No patients match "nobody"/)
    await expectAccessible(container)
  })

  it('patient detail', async () => {
    const { container } = await renderWithRouter(PatientDetailView, {
      path: '/patients/7',
      props: { patientId: '7' },
    })
    await screen.findByRole('heading', { name: 'Jordan Lee' })
    await screen.findByRole('heading', { name: 'Orders' })
    await expectAccessible(container)
  })

  it('order builder empty', async () => {
    const { container } = await renderBuilder()
    await screen.findByText('No lines yet. Add a product to start.')
    await expectAccessible(container)
  })

  it('order builder with complete lines', async () => {
    const { container } = await renderBuilder()
    const user = userEvent.setup()
    await addProduct(user, 'Vitamin D3', '20.00')
    await screen.findByText('Patient pays')
    await expectAccessible(container)
  })

  it('order builder with a Qty error in the line error list', async () => {
    const { container } = await renderBuilder()
    const user = userEvent.setup()
    await addProduct(user, 'Vitamin D3')
    const qty = screen.getByRole('textbox', { name: /^Qty Vitamin D3/ })
    await replaceInput(user, qty, '0')
    await vi.waitFor(() => {
      expect(qty).toBeInvalid()
    })
    await screen.findByText(/^Qty \(Vitamin D3\) - /)
    await expectAccessible(container)
  })

  it('order builder general error banner', async () => {
    const { container } = await renderBuilder()
    const user = userEvent.setup()
    await addProduct(user, 'Vitamin D3', '20.00')
    await screen.findByText('Patient pays')
    vi.mocked(api.createOrder).mockRejectedValue(
      new api.ApiRequestError(500, 'INTERNAL', 'Could not save the draft'),
    )
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByRole('alert')
    await screen.findByText('Could not save the draft')
    await expectAccessible(container)
  })

  it('add-product modal step 1 with disabled rows', async () => {
    const { container } = await renderBuilder()
    const user = userEvent.setup()
    await addProduct(user, 'Vitamin D3')
    await user.click(screen.getByRole('button', { name: 'Add line' }))
    await screen.findByRole('heading', {
      name: 'Add product: choose a product',
    })
    await screen.findByText('Already added')
    await screen.findByText('Out of stock')
    await expectNoAxeViolations(screen.getByRole('dialog'))
    await expectAccessible(container)
  })

  it('add-product modal step 2 validation error', async () => {
    const { container } = await renderBuilder()
    const user = userEvent.setup()
    await chooseProduct(user, 'Magnesium')
    await replaceInput(
      user,
      screen.getByLabelText('Patient price (each)'),
      '1.00',
    )
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    await screen.findByText(/Price must be at least/)
    expect(
      screen.queryByRole('textbox', { name: /^Qty Magnesium/ }),
    ).not.toBeInTheDocument()
    await expectNoAxeViolations(screen.getByRole('dialog'))
    await expectAccessible(container)
  })

  it('provider order detail paid with journal', async () => {
    const { container } = await renderWithRouter(ProviderOrderView, {
      path: '/orders/7',
      props: { orderId: '7' },
    })
    await screen.findByRole('heading', { name: /Order #7/ })
    await screen.findByRole('heading', { name: 'Journal' })
    await screen.findByText('fake_ch_123')
    await expectAccessible(container)
  })

  it('dashboard stat tiles, order links, and inventory search', async () => {
    const { container } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('GMV')
    expect(
      screen.getByRole('link', { name: 'See paid orders →' }),
    ).toHaveAttribute('href', '/orders?status=paid')
    expect(
      screen.getByRole('link', { name: 'See orders awaiting payment →' }),
    ).toHaveAttribute('href', '/orders?status=pending_payment')
    await screen.findByText('Vitamin D3')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Search products'), 'Vitamin')
    await vi.waitFor(() => {
      expect(api.searchProducts).toHaveBeenLastCalledWith({
        q: 'Vitamin',
        offset: 0,
        limit: 25,
      })
    })
    await screen.findByText('Vitamin D3')
    await expectAccessible(container)
  })

  it('dashboard date range control with the custom picker open', async () => {
    const { container } = await renderWithRouter(DashboardView, {
      path: '/dashboard',
    })
    await screen.findByText('GMV')
    await screen.findByText('Vitamin D3')
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Custom' }))
    expect(
      screen.getByRole('combobox', { name: 'Custom date range' }),
    ).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('patient my orders', async () => {
    vi.mocked(api.listOrders).mockResolvedValue(myOrders)
    const { container } = await renderWithRouter(MyOrdersView, {
      path: '/my-orders',
    })
    await screen.findByRole('heading', { name: 'My orders' })
    await screen.findByText('Dr. Maya Rivera')
    await expectAccessible(container)
  })

  it('patient pay pending', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(pendingPatientOrder)
    const { container } = await renderWithRouter(PatientOrderView, {
      path: '/my-orders/42',
      props: { orderId: '42' },
    })
    await screen.findByRole('button', { name: 'Pay $120.00' })
    await expectAccessible(container)
  })

  it('patient pay failed payment message', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(pendingPatientOrder)
    vi.mocked(api.payOrder).mockRejectedValue(
      new api.ApiRequestError(402, 'PAYMENT_FAILED', 'Card declined'),
    )
    const { container } = await renderWithRouter(PatientOrderView, {
      path: '/my-orders/42',
      props: { orderId: '42' },
    })
    await screen.findByRole('button', { name: 'Pay $120.00' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Pay $120.00' }))
    await screen.findByText(/Card declined/)
    await expectAccessible(container)
  })

  it('patient pay paid receipt', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(paidPatientOrder)
    const { container } = await renderWithRouter(PatientOrderView, {
      path: '/my-orders/42',
      props: { orderId: '42' },
    })
    await screen.findByRole('heading', { name: 'Receipt' })
    await screen.findByText('fake_ch_123')
    await expectAccessible(container)
  })
})
