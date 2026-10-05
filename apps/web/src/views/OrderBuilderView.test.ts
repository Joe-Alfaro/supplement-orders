import type {
  ListQuery,
  PatientDto,
  ProductDto,
  ProductPageDto,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import { fireEvent, screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import OrderBuilderView from './OrderBuilderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    listProducts: vi.fn(),
    getPatient: vi.fn(),
    getOrder: vi.fn(),
    createOrder: vi.fn(),
    replaceOrderLines: vi.fn(),
    sendOrder: vi.fn(),
  }
})

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

/** A fake GET /api/products: substring match on name or SKU, one page. */
function productPage(query: ListQuery): ProductPageDto {
  const q = query.q?.toLowerCase() ?? ''
  const items = products.filter(
    (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
  )
  return { items, total: items.length, offset: 0, limit: query.limit ?? 25 }
}

const patient: PatientDto = {
  id: 7,
  userId: 3,
  providerId: 1,
  name: 'Jordan Lee',
  address: '214 Alder St',
  orderCount: 0,
  latestOrderStatus: null,
}

async function renderBuilder(orderId?: string) {
  const result = await renderWithRouter(OrderBuilderView, {
    path: '/patients/7/orders/new',
    props: { patientId: '7', orderId },
  })
  await screen.findByRole('heading', { name: /New order|Draft order/ })
  return result
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send to patient' })
}

function inputValue(label: string) {
  return (screen.getByLabelText(label) as HTMLInputElement).value
}

/** A saved draft as the API returns it; only the fields the builder reads matter. */
function draftDetail(
  lines: ProviderOrderDetailDto['lines'],
): ProviderOrderDetailDto {
  return {
    id: 99,
    view: 'provider',
    status: 'draft',
    patientId: 7,
    patientName: 'Jordan Lee',
    providerId: 1,
    providerName: 'Dr. Maya Rivera',
    createdAt: '2026-10-05T12:00:00.000Z',
    sentAt: null,
    paidAt: null,
    split: null,
    patientAddress: '214 Alder St',
    lines,
    payment: null,
    ledger: [],
  }
}

// Vitamin D3 costs $12.00, so its minimum price is 1200 + ceil(75 * 1200 / 9925) = $12.10.

function dialogElement() {
  const dialog = document.querySelector('dialog')
  if (!dialog) throw new Error('no dialog')
  return dialog
}

async function openAddProduct() {
  await fireEvent.click(screen.getByRole('button', { name: 'Add line' }))
  await screen.findByRole('heading', { name: /choose a product/ })
}

async function chooseProduct(name: string) {
  await fireEvent.click(await within(dialogElement()).findByText(name))
  await screen.findByRole('heading', { name: `Add ${name}` })
}

/** Adds a product through the two-step modal. */
async function addProduct(
  name: string,
  fields: { qty?: string; margin?: string; price?: string } = {},
) {
  await openAddProduct()
  await chooseProduct(name)
  if (fields.qty)
    await fireEvent.update(screen.getByLabelText('Qty'), fields.qty)
  if (fields.margin) {
    await fireEvent.update(screen.getByLabelText('Margin %'), fields.margin)
  }
  if (fields.price) {
    await fireEvent.update(
      screen.getByLabelText('Patient price (each)'),
      fields.price,
    )
  }
  await fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
}

beforeEach(() => {
  vi.mocked(api.listProducts)
    .mockReset()
    .mockImplementation(async (query = {}) => productPage(query))
  vi.mocked(api.getPatient).mockResolvedValue(patient)
})

describe('OrderBuilderView', () => {
  it('shows a red Min hint and disables Send when priced below the minimum', async () => {
    await renderBuilder()
    await addProduct('Vitamin D3')

    expect(screen.getByTestId('product-0').textContent).toBe('Vitamin D3')
    await fireEvent.update(
      screen.getByLabelText('Patient price for line 1'),
      '12.05',
    )

    const hint = screen.getByTestId('min-0')
    expect(hint.textContent?.trim()).toBe('Min $12.10')
    expect(hint.classList.contains('negative')).toBe(true)
    expect(
      screen
        .getByLabelText('Patient price for line 1')
        .getAttribute('aria-invalid'),
    ).toBe('true')
    expect(sendButton()).toHaveProperty('disabled', true)

    await fireEvent.update(
      screen.getByLabelText('Patient price for line 1'),
      '12.10',
    )
    expect(screen.getByTestId('min-0').classList.contains('negative')).toBe(
      false,
    )
    expect(sendButton()).toHaveProperty('disabled', false)
  })

  it('links Margin % and Patient price both ways without overwriting the typed field', async () => {
    await renderBuilder()
    await addProduct('Vitamin D3')

    // 40% margin on $12.00 cost: 1200 * 10000 / 6000 = $20.00.
    await fireEvent.update(screen.getByLabelText('Margin % for line 1'), '40')
    expect(inputValue('Patient price for line 1')).toBe('20.00')
    expect(inputValue('Margin % for line 1')).toBe('40')

    // $30.00 price: (3000 - 1200) / 3000 = 60.00%.
    await fireEvent.update(
      screen.getByLabelText('Patient price for line 1'),
      '30',
    )
    expect(inputValue('Margin % for line 1')).toBe('60.00')
    expect(inputValue('Patient price for line 1')).toBe('30')
  })

  it('saves incomplete lines as a draft and restores them on reload', async () => {
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    const saved = draftDetail([
      {
        productId: 1,
        productName: 'Vitamin D3',
        sku: 'VITD',
        quantity: 2,
        unitPriceCents: null,
        lineTotalCents: null,
        unitCogsCents: 1200,
        marginBps: null,
        minUnitPriceCents: 1210,
      },
      {
        productId: null,
        productName: null,
        sku: null,
        quantity: 1,
        unitPriceCents: 2500,
        lineTotalCents: 2500,
        unitCogsCents: null,
        marginBps: null,
        minUnitPriceCents: null,
      },
    ])
    vi.mocked(api.replaceOrderLines).mockResolvedValue(saved)
    vi.mocked(api.getOrder).mockResolvedValue(saved)
    const first = await renderBuilder()

    // Added with a quantity but no price yet: incomplete, but saveable.
    await addProduct('Vitamin D3', { qty: '2' })
    expect(sendButton()).toHaveProperty('disabled', true)

    const save = screen.getByRole('button', { name: 'Save draft' })
    expect(save).toHaveProperty('disabled', false)
    await fireEvent.click(save)

    expect(await screen.findByText('Draft saved.')).toBeTruthy()
    expect(api.replaceOrderLines).toHaveBeenCalledWith(99, [
      { productId: 1, quantity: 2, unitPriceCents: null },
    ])

    // Reload the builder for the saved draft: both incomplete lines come back.
    first.unmount()
    await renderBuilder('99')
    expect(screen.getByTestId('product-0').textContent).toBe('Vitamin D3')
    expect(inputValue('Quantity for line 1')).toBe('2')
    expect(inputValue('Patient price for line 1')).toBe('')
    expect(screen.getByText('No product (remove this line)')).toBeTruthy()
    expect(inputValue('Patient price for line 2')).toBe('25.00')
    expect(sendButton()).toHaveProperty('disabled', true)
  })

  it('keeps Send disabled until every line is complete and at its minimum', async () => {
    await renderBuilder()
    expect(sendButton()).toHaveProperty('disabled', true)

    await addProduct('Vitamin D3', { price: '20' })
    expect(sendButton()).toHaveProperty('disabled', false)

    await addProduct('Magnesium')
    expect(sendButton()).toHaveProperty('disabled', true)

    await fireEvent.update(
      screen.getByLabelText('Patient price for line 2'),
      '20',
    )
    expect(sendButton()).toHaveProperty('disabled', false)
  })

  it('places a server field error next to the offending input', async () => {
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockRejectedValue(
      new api.ApiRequestError(
        422,
        'INSUFFICIENT_STOCK',
        'Only 3 left',
        'lines.0.quantity',
      ),
    )
    await renderBuilder()
    await addProduct('Vitamin D3', { price: '20' })

    await fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByText('Only 3 left')).toBeTruthy()
    expect(
      screen.getByLabelText('Quantity for line 1').getAttribute('aria-invalid'),
    ).toBe('true')
  })

  it('shows a field-less EMPTY_ORDER error in the general banner', async () => {
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    vi.mocked(api.sendOrder).mockRejectedValue(
      new api.ApiRequestError(
        422,
        'EMPTY_ORDER',
        'An order needs at least one line',
      ),
    )
    const { container } = await renderBuilder()
    await addProduct('Vitamin D3', { price: '20' })

    await fireEvent.click(sendButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('An order needs at least one line')
    expect(container.querySelector('.field-error')).toBeNull()
  })
})

describe('Add-product modal', () => {
  it('searches products on the server, debounced', async () => {
    await renderBuilder()
    await openAddProduct()
    expect(document.activeElement).toBe(
      screen.getByLabelText('Search products'),
    )

    const search = screen.getByLabelText('Search products')
    await fireEvent.update(search, 'm')
    await fireEvent.update(search, 'mag')

    await vi.waitFor(() =>
      expect(api.listProducts).toHaveBeenLastCalledWith({
        q: 'mag',
        offset: 0,
        limit: 25,
      }),
    )
    // Only the settled query went out, not each keystroke.
    expect(api.listProducts).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'm' }),
    )
    await vi.waitFor(() =>
      expect(within(dialogElement()).queryByText('Vitamin D3')).toBeNull(),
    )
    expect(within(dialogElement()).getByText('Magnesium')).toBeTruthy()
  })

  it('disables products already on the order and out-of-stock products', async () => {
    await renderBuilder()
    await addProduct('Vitamin D3')
    await openAddProduct()

    const added = await within(dialogElement()).findByTestId('product-row-1')
    expect(added.getAttribute('aria-disabled')).toBe('true')
    expect(added.textContent).toContain('Already added')
    const outOfStock = within(dialogElement()).getByTestId('product-row-3')
    expect(outOfStock.getAttribute('aria-disabled')).toBe('true')
    expect(outOfStock.textContent).toContain('Out of stock')

    await fireEvent.click(added)
    await fireEvent.keyDown(outOfStock, { key: 'Enter' })
    expect(
      screen.getByRole('heading', { name: /choose a product/ }),
    ).toBeTruthy()
  })

  it('goes to step 2 on a row, and Back keeps the search', async () => {
    await renderBuilder()
    await openAddProduct()
    await fireEvent.update(screen.getByLabelText('Search products'), 'mag')
    await vi.waitFor(() =>
      expect(within(dialogElement()).queryByText('Vitamin D3')).toBeNull(),
    )

    const row = within(dialogElement()).getByTestId('product-row-2')
    await fireEvent.keyDown(row, { key: 'Enter' })
    expect(
      await screen.findByRole('heading', { name: 'Add Magnesium' }),
    ).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Qty'))

    await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(inputValue('Search products')).toBe('mag')
    expect(within(dialogElement()).queryByText('Vitamin D3')).toBeNull()
    expect(within(dialogElement()).getByText('Magnesium')).toBeTruthy()
  })

  it('appends the line, closes, and focuses the new Qty input', async () => {
    await renderBuilder()
    await addProduct('Vitamin D3', { qty: '3', margin: '40' })

    expect(dialogElement().hasAttribute('open')).toBe(false)
    expect(screen.getByTestId('product-0').textContent).toBe('Vitamin D3')
    expect(inputValue('Quantity for line 1')).toBe('3')
    expect(inputValue('Patient price for line 1')).toBe('20.00')
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText('Quantity for line 1'),
      ),
    )
  })

  it('links Margin % and price in step 2 and blocks a below-minimum price', async () => {
    await renderBuilder()
    await openAddProduct()
    await chooseProduct('Vitamin D3')

    await fireEvent.update(screen.getByLabelText('Margin %'), '40')
    expect(inputValue('Patient price (each)')).toBe('20.00')

    await fireEvent.update(
      screen.getByLabelText('Patient price (each)'),
      '12.05',
    )
    expect(inputValue('Margin %')).toBe('0.41')
    await fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))

    expect(screen.getByText('Price must be at least $12.10')).toBeTruthy()
    expect(dialogElement().hasAttribute('open')).toBe(true)
    expect(screen.queryByTestId('product-0')).toBeNull()
  })

  it('closes on Escape and returns focus to Add line', async () => {
    await renderBuilder()
    await openAddProduct()

    await fireEvent.keyDown(dialogElement(), { key: 'Escape' })

    expect(dialogElement().hasAttribute('open')).toBe(false)
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Add line' }),
      ),
    )
  })
})
