import type {
  PatientDto,
  ProductPageDto,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import OrderBuilderView from './OrderBuilderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    searchProducts: vi.fn(),
    getPatient: vi.fn(),
    getOrder: vi.fn(),
    createOrder: vi.fn(),
    replaceOrderLines: vi.fn(),
    sendOrder: vi.fn(),
  }
})

const patient: PatientDto = {
  id: 7,
  userId: 3,
  providerId: 1,
  name: 'Jordan Lee',
  dateOfBirth: '1984-03-14',
  address: '214 Alder St',
  orderCount: 1,
  latestOrderStatus: 'draft',
}

const productPage: ProductPageDto = {
  items: [
    { id: 2, sku: 'MAG', name: 'Magnesium', cogsCents: 1500, stockQuantity: 3 },
  ],
  total: 1,
  offset: 0,
  limit: 25,
}

/** A saved draft with Magnesium x5 and Vitamin D3 x1; Magnesium has 3 in stock. */
const draft = {
  id: 99,
  view: 'provider',
  revision: 0,
  status: 'draft',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: null,
  paidAt: null,
  cancelledAt: null,
  split: null,
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St',
  payment: null,
  journal: null,
  lines: [
    {
      productId: 2,
      productName: 'Magnesium',
      sku: 'MAG',
      quantity: 5,
      unitPriceCents: 2000,
      lineTotalCents: 10000,
      unitCogsCents: 1500,
      markupBps: 3333,
      minUnitPriceCents: 1512,
      stockQuantity: 3,
      availableQuantity: 3,
    },
    {
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 1,
      unitPriceCents: 2000,
      lineTotalCents: 2000,
      unitCogsCents: 1200,
      markupBps: 6666,
      minUnitPriceCents: 1210,
      stockQuantity: 10,
      availableQuantity: 10,
    },
  ],
} as unknown as ProviderOrderDetailDto

async function renderBuilder() {
  vi.mocked(api.getOrder).mockResolvedValue(draft)
  vi.mocked(api.replaceOrderLines).mockResolvedValue(draft)
  await renderWithRouter(OrderBuilderView, {
    path: '/patients/7/orders/99',
    props: { patientId: '7', orderId: '99' },
  })
  await screen.findByRole('heading', { name: /Draft order #99/ })
}

beforeEach(() => {
  vi.mocked(api.getPatient).mockResolvedValue(patient)
  vi.mocked(api.searchProducts).mockResolvedValue(productPage)
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.replaceOrderLines).mockReset()
  vi.mocked(api.sendOrder).mockReset()
})

describe('OrderBuilderView low stock', () => {
  it('shows one warning above Send instead of per-line warnings', async () => {
    await renderBuilder()

    expect(
      screen.getAllByText(/higher quantity than is currently in stock/),
    ).toHaveLength(1)
    expect(screen.queryByText(/Only 3 in stock/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: 'Order line warnings' }),
    ).not.toBeInTheDocument()
    const qty = screen.getByRole('textbox', { name: 'Qty Magnesium' })
    expect(qty).not.toHaveAttribute('aria-invalid', 'true')
    expect(qty).not.toHaveAttribute('aria-describedby')
    expect(
      screen.getByRole('button', { name: 'Send to patient' }),
    ).toBeEnabled()
  })

  it('Send opens a confirmation listing the line; Back to order does not send', async () => {
    const user = userEvent.setup()
    await renderBuilder()

    await user.click(screen.getByRole('button', { name: 'Send to patient' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Send with limited stock?',
    })
    expect(
      within(dialog).getByText('Magnesium: 5 requested, 3 in stock'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "The patient can pay for what's in stock now. The rest will become a separate back-order they can pay when stock returns.",
      ),
    ).toBeInTheDocument()

    await user.click(
      within(dialog).getByRole('button', { name: 'Back to order' }),
    )
    expect(api.sendOrder).not.toHaveBeenCalled()
  })

  it('Send anyway sends with acknowledgeLowStock', async () => {
    const user = userEvent.setup()
    vi.mocked(api.sendOrder).mockResolvedValue(draft)
    await renderBuilder()

    await user.click(screen.getByRole('button', { name: 'Send to patient' }))
    await user.click(await screen.findByRole('button', { name: 'Send anyway' }))

    expect(api.sendOrder).toHaveBeenCalledWith(99, {
      acknowledgeLowStock: true,
    })
  })

  it('a 409 LOW_STOCK_UNACKNOWLEDGED reopens the dialog with the server lines', async () => {
    const user = userEvent.setup()
    const cleanDraft = {
      ...draft,
      lines: draft.lines.map((line) => ({ ...line, availableQuantity: 99 })),
    } as unknown as ProviderOrderDetailDto
    vi.mocked(api.getOrder).mockResolvedValue(cleanDraft)
    vi.mocked(api.replaceOrderLines).mockResolvedValue(cleanDraft)
    vi.mocked(api.sendOrder).mockRejectedValue(
      new api.ApiRequestError(
        409,
        'LOW_STOCK_UNACKNOWLEDGED',
        'Low stock',
        undefined,
        undefined,
        {
          lines: [
            {
              lineId: 1,
              productId: 2,
              productName: 'Magnesium',
              quantity: 5,
              availableQuantity: 1,
            },
          ],
        },
      ),
    )
    await renderWithRouter(OrderBuilderView, {
      path: '/patients/7/orders/99',
      props: { patientId: '7', orderId: '99' },
    })
    await screen.findByRole('heading', { name: /Draft order #99/ })

    await user.click(screen.getByRole('button', { name: 'Send to patient' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Send with limited stock?',
    })
    expect(
      within(dialog).getByText('Magnesium: 5 requested, 1 in stock'),
    ).toBeInTheDocument()
  })

  it('warns in the add dialog, under the fields, and still allows adding', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(draft)
    await renderWithRouter(OrderBuilderView, {
      path: '/patients/7/orders/new',
      props: { patientId: '7', orderId: 'new' },
    })
    await screen.findByRole('heading', { name: /New order/ })
    await user.click(screen.getByRole('button', { name: 'Add line' }))
    await user.click(await screen.findByText('Magnesium'))

    const qty = await screen.findByRole('textbox', { name: 'Qty' })
    await user.clear(qty)
    await user.type(qty, '5')

    const warnings = screen.getByTestId('add-product-warnings')
    expect(
      within(warnings).getByText(
        'More than the 3 in stock — the rest will be back-ordered.',
      ),
    ).toBeInTheDocument()
    expect(warnings).toHaveAttribute('aria-live', 'polite')
    // A warning is not an error: nothing is marked invalid and Add works.
    expect(qty).not.toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.queryByRole('list', { name: 'Errors' }),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(screen.queryByText(/Only 3 in stock/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/higher quantity than is currently in stock/),
    ).toBeInTheDocument()
  })
})
