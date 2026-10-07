import type {
  ListQuery,
  PatientDto,
  ProductDto,
  ProductPageDto,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import userEvent, { type UserEvent } from '@testing-library/user-event'
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
  // Costs taken from the revision 5 contract's reference values.
  { id: 4, sku: 'OMEGA', name: 'Omega-3', cogsCents: 1000, stockQuantity: 20 },
  { id: 5, sku: 'BCOMP', name: 'B-Complex', cogsCents: 850, stockQuantity: 20 },
  { id: 6, sku: 'SAMPLE', name: 'Sample Pack', cogsCents: 0, stockQuantity: 5 },
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
  dateOfBirth: '1984-03-14',
  address: '214 Alder St',
  orderCount: 0,
  latestOrderStatus: null,
}

async function renderBuilder(orderId?: string) {
  const view = await renderWithRouter(OrderBuilderView, {
    path: '/patients/7/orders/new',
    props: { patientId: '7', orderId },
  })
  await screen.findByRole('heading', { name: /New order|Draft order/ })
  return view
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send to patient' })
}

/** A saved draft as the API returns it; only the fields the builder reads matter. */
function draftDetail(
  lines: ProviderOrderDetailDto['lines'],
): ProviderOrderDetailDto {
  return {
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
    revision: 0,
    split: null,
    patientDateOfBirth: '1984-03-14',
    patientAddress: '214 Alder St',
    lines,
    payment: null,
    ledger: [],
  }
}

// Vitamin D3 costs $12.00, so its minimum price is 1200 + ceil(75 * 1200 / 9925) = $12.10.

/**
 * Replaces a text field's value the way a user would: clear it, then type.
 * Fields are found by exact accessible name; in-row inputs are named by their
 * column header plus the row's product, e.g. "Qty Vitamin D3".
 */
async function fill(user: UserEvent, name: string, value: string) {
  const field = screen.getByRole('textbox', { name })
  await user.clear(field)
  if (value !== '') await user.type(field, value)
}

function dialog() {
  return screen.getByRole('dialog')
}

/** The picker row for a product, by its accessible name. */
function productRow(name: string) {
  return within(dialog()).getByRole('row', { name: new RegExp(name) })
}

async function expectDialogClosed() {
  await vi.waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  )
}

async function openAddProduct(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Add line' }))
  await screen.findByRole('heading', { name: /choose a product/ })
}

async function chooseProduct(user: UserEvent, name: string) {
  await user.click(await within(dialog()).findByText(name))
  await screen.findByRole('heading', { name: `Add ${name}` })
}

/** Adds a product through the two-step modal. */
async function addProduct(
  user: UserEvent,
  name: string,
  fields: { qty?: string; markup?: string; price?: string } = {},
) {
  await openAddProduct(user)
  await chooseProduct(user, name)
  if (fields.qty) await fill(user, 'Qty', fields.qty)
  if (fields.markup) await fill(user, 'Markup %', fields.markup)
  // Step 2 prefills the minimum price; pass price: '' to leave the line incomplete.
  if (fields.price !== undefined) {
    await fill(user, 'Patient price (each)', fields.price)
  }
  await user.click(screen.getByRole('button', { name: 'Add to order' }))
}

beforeEach(() => {
  vi.mocked(api.searchProducts)
    .mockReset()
    .mockImplementation(async (query = {}) => productPage(query))
  vi.mocked(api.getPatient).mockResolvedValue(patient)
})

describe('OrderBuilderView', () => {
  it('shows a red Min hint and disables Send when priced below the minimum', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Vitamin D3')

    expect(screen.getByTestId('product-0')).toHaveTextContent('Vitamin D3')
    await fill(user, 'Patient price (each) Vitamin D3', '12.05')
    expect(
      screen.getByRole('table', { name: 'Order lines' }),
    ).toBeInTheDocument()

    const hint = screen.getByTestId('min-0')
    expect(hint).toHaveTextContent('Min $12.10')
    expect(hint).toHaveClass('negative')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Vitamin D3' }),
    ).toHaveAttribute('aria-invalid', 'true')
    expect(sendButton()).toBeDisabled()

    await fill(user, 'Patient price (each) Vitamin D3', '12.10')
    expect(screen.getByTestId('min-0')).not.toHaveClass('negative')
    expect(sendButton()).toBeEnabled()
  })

  it('links Markup % and Patient price both ways without overwriting the typed field', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3')

    // 300% net markup on a $10.00 cost is $40.30 (contract reference value).
    await fill(user, 'Markup % Omega-3', '300')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Omega-3' }),
    ).toHaveValue('40.30')
    expect(
      screen.getByRole('textbox', { name: 'Markup % Omega-3' }),
    ).toHaveValue('300')

    // $40.00 on $10.00: (9925 * 4000 - 10000 * 1000) / 1000 = 297.00%.
    await fill(user, 'Patient price (each) Omega-3', '40')
    expect(
      screen.getByRole('textbox', { name: 'Markup % Omega-3' }),
    ).toHaveValue('297.00')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Omega-3' }),
    ).toHaveValue('40')
  })

  it('saves incomplete lines as a draft and restores them on reload', async () => {
    const user = userEvent.setup()
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
        markupBps: null,
        minUnitPriceCents: 1210,
        stockQuantity: 10,
      },
      {
        productId: null,
        productName: null,
        sku: null,
        quantity: 1,
        unitPriceCents: 2500,
        lineTotalCents: 2500,
        unitCogsCents: null,
        markupBps: null,
        minUnitPriceCents: null,
        stockQuantity: null,
      },
    ])
    vi.mocked(api.replaceOrderLines).mockResolvedValue(saved)
    vi.mocked(api.getOrder).mockResolvedValue(saved)
    const view = await renderBuilder()

    // Added with a quantity but no price yet: incomplete, but saveable.
    await addProduct(user, 'Vitamin D3', { qty: '2', price: '' })
    expect(sendButton()).toBeDisabled()

    const save = screen.getByRole('button', { name: 'Save draft' })
    expect(save).toBeEnabled()
    await user.click(save)

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument()
    expect(api.replaceOrderLines).toHaveBeenCalledWith(99, [
      { productId: 1, quantity: 2, unitPriceCents: null },
    ])

    // Reload the builder for the saved draft: both incomplete lines come back.
    view.unmount()
    await renderBuilder('99')
    expect(screen.getByTestId('product-0')).toHaveTextContent('Vitamin D3')
    expect(screen.getByRole('textbox', { name: 'Qty Vitamin D3' })).toHaveValue(
      '2',
    )
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Vitamin D3' }),
    ).toHaveValue('')
    expect(
      screen.getByText('No product (remove this line)'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', {
        name: 'Patient price (each) No product (remove this line)',
      }),
    ).toHaveValue('25.00')
    expect(sendButton()).toBeDisabled()
  })

  it('keeps Send disabled until every line is complete and at its minimum', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    expect(sendButton()).toBeDisabled()

    await addProduct(user, 'Vitamin D3', { price: '20' })
    expect(sendButton()).toBeEnabled()

    await addProduct(user, 'Magnesium', { price: '' })
    expect(sendButton()).toBeDisabled()

    await fill(user, 'Patient price (each) Magnesium', '20')
    expect(sendButton()).toBeEnabled()
  })

  it('places a server field error next to the offending input', async () => {
    const user = userEvent.setup()
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
    await addProduct(user, 'Vitamin D3', { price: '20' })

    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByText('Only 3 left')).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Qty Vitamin D3' }),
    ).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows a field-less EMPTY_ORDER error in the general banner', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    vi.mocked(api.sendOrder).mockRejectedValue(
      new api.ApiRequestError(
        422,
        'EMPTY_ORDER',
        'An order needs at least one line',
      ),
    )
    await renderBuilder()
    await addProduct(user, 'Vitamin D3', { price: '20' })

    await user.click(sendButton())

    // One general banner, and no field marked invalid.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('An order needs at least one line')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    ;[
      'Qty Vitamin D3',
      'Markup % Vitamin D3',
      'Patient price (each) Vitamin D3',
    ].forEach((label) =>
      expect(screen.getByRole('textbox', { name: label })).not.toHaveAttribute(
        'aria-invalid',
        'true',
      ),
    )
  })
})

describe('Add-product modal', () => {
  it('searches products on the server, debounced', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    const search = screen.getByRole('searchbox', { name: 'Search products' })
    await vi.waitFor(() => expect(search).toHaveFocus())

    await user.type(search, 'mag')

    await vi.waitFor(() =>
      expect(api.searchProducts).toHaveBeenLastCalledWith({
        q: 'mag',
        offset: 0,
        limit: 25,
      }),
    )
    // Only the settled query went out, not each keystroke.
    expect(api.searchProducts).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'm' }),
    )
    await vi.waitFor(() =>
      expect(
        within(dialog()).queryByText('Vitamin D3'),
      ).not.toBeInTheDocument(),
    )
    expect(within(dialog()).getByText('Magnesium')).toBeInTheDocument()
  })

  it('disables products already on the order and out-of-stock products', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Vitamin D3')
    await openAddProduct(user)

    await within(dialog()).findByText('Already added')
    expect(
      within(dialog()).getByRole('table', { name: 'Products' }),
    ).toBeInTheDocument()
    const added = productRow('Vitamin D3')
    expect(added).toHaveClass('row-unavailable')
    expect(added).toHaveTextContent('Already added')
    const outOfStock = productRow('Zinc')
    expect(outOfStock).toHaveClass('row-unavailable')
    expect(outOfStock).toHaveTextContent('Out of stock')

    await user.click(added)
    outOfStock.focus()
    await user.keyboard('{Enter}')
    expect(
      screen.getByRole('heading', { name: /choose a product/ }),
    ).toBeInTheDocument()
  })

  it('goes to step 2 on a row, and Back keeps the search', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await user.type(
      screen.getByRole('searchbox', { name: 'Search products' }),
      'mag',
    )
    await vi.waitFor(() =>
      expect(
        within(dialog()).queryByText('Vitamin D3'),
      ).not.toBeInTheDocument(),
    )

    productRow('Magnesium').focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByRole('heading', { name: 'Add Magnesium' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Qty' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      screen.getByRole('searchbox', { name: 'Search products' }),
    ).toHaveValue('mag')
    expect(within(dialog()).queryByText('Vitamin D3')).not.toBeInTheDocument()
    expect(within(dialog()).getByText('Magnesium')).toBeInTheDocument()
  })

  it('appends the line, closes, and focuses the new Qty input', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3', { qty: '3', markup: '300' })

    await expectDialogClosed()
    expect(screen.getByTestId('product-0')).toHaveTextContent('Omega-3')
    expect(screen.getByRole('textbox', { name: 'Qty Omega-3' })).toHaveValue(
      '3',
    )
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Omega-3' }),
    ).toHaveValue('40.30')
    await vi.waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Qty Omega-3' }),
      ).toHaveFocus(),
    )
  })

  it('links Markup % and price in step 2 and blocks a below-minimum price', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Omega-3')

    await fill(user, 'Markup %', '300')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('40.30')

    // $10.05 is below the $10.08 minimum: markup -0.25% (half up toward +infinity).
    await fill(user, 'Patient price (each)', '10.05')
    expect(screen.getByRole('textbox', { name: 'Markup %' })).toHaveValue(
      '-0.25',
    )
    await user.click(screen.getByRole('button', { name: 'Add to order' }))

    expect(
      screen.getByText('Price must be at least $10.08'),
    ).toBeInTheDocument()
    expect(dialog()).toBeInTheDocument()
    expect(screen.queryByTestId('product-0')).not.toBeInTheDocument()
  })

  it('closes on Escape and returns focus to Add line', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    // Escape is live once the dialog has finished opening and focused search.
    await vi.waitFor(() =>
      expect(
        screen.getByRole('searchbox', { name: 'Search products' }),
      ).toHaveFocus(),
    )

    await user.keyboard('{Escape}')

    await expectDialogClosed()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add line' })).toHaveFocus(),
    )
  })
})

describe('OrderBuilderView in-row input names', () => {
  it('names each in-row input by its visible column header and product', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Magnesium')

    // Every word of the accessible name is on screen: the <th> plus the product cell.
    expect(screen.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
    expect(screen.getByTestId('product-0')).toHaveTextContent('Magnesium')
    expect(
      screen.getByRole('textbox', { name: /^Qty Magnesium/ }),
    ).toHaveAccessibleName('Qty Magnesium')
    expect(
      screen.getByRole('textbox', { name: /^Markup % Magnesium/ }),
    ).toHaveAccessibleName('Markup % Magnesium')
    expect(
      screen.getByRole('textbox', {
        name: /^Patient price \(each\) Magnesium/,
      }),
    ).toHaveAccessibleName('Patient price (each) Magnesium')
    // No visually hidden "… for line N" labels remain.
    expect(screen.queryByLabelText(/for line \d/)).not.toBeInTheDocument()
  })
})

describe('OrderBuilderView patient and stock', () => {
  it('shows the patient name and DOB in the heading', async () => {
    await renderBuilder()

    expect(
      screen.getByRole('heading', {
        name: 'New order for Jordan Lee · DOB 03/14/1984',
      }),
    ).toBeInTheDocument()
  })

  it('caps Qty on a reloaded line by the live stock from the API', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(
      draftDetail([
        {
          productId: 1,
          productName: 'Vitamin D3',
          sku: 'VITD',
          quantity: 2,
          unitPriceCents: 2000,
          lineTotalCents: 4000,
          unitCogsCents: 1200,
          markupBps: 4000,
          minUnitPriceCents: 1210,
          stockQuantity: 3,
        },
      ]),
    )
    await renderBuilder('99')

    expect(screen.getByText(/3 in stock/)).toBeInTheDocument()
    expect(screen.queryByText(/stock checked on send/)).not.toBeInTheDocument()
    expect(sendButton()).toBeEnabled()

    await fill(user, 'Qty Vitamin D3', '4')
    expect(screen.getByText('Only 3 in stock')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
  })

  it('keeps price and markup as text inputs holding integer cents (no InputNumber)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Vitamin D3')

    // InputNumber renders a spinbutton; money and percent fields must be plain textboxes.
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Markup %' }),
    ).toBeInTheDocument()
    await fill(user, 'Patient price (each)', '12.50')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('12.50')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))

    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Vitamin D3' }),
    ).toHaveValue('12.50')
    expect(
      screen.getByRole('textbox', { name: 'Markup % Vitamin D3' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await vi.waitFor(() =>
      expect(api.replaceOrderLines).toHaveBeenCalledWith(99, [
        { productId: 1, quantity: 1, unitPriceCents: 1250 },
      ]),
    )
  })

  it('prefills Patient price with the minimum and derives Markup %', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'B-Complex')

    // Minimum for a $8.50 cost is $8.57, a net markup of 0.07% (contract values).
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('8.57')
    expect(screen.getByRole('textbox', { name: 'Markup %' })).toHaveValue(
      '0.07',
    )

    // 0% markup means the minimum price.
    await fill(user, 'Markup %', '0')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('8.57')

    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) B-Complex' }),
    ).toHaveValue('8.57')
    expect(sendButton()).toBeEnabled()
  })

  it('accepts markup above 100% and shows it with two decimals', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3')

    await fill(user, 'Markup % Omega-3', '300')
    await user.tab()
    expect(
      screen.getByRole('textbox', { name: 'Markup % Omega-3' }),
    ).toHaveValue('300.00')
    expect(
      screen.getByRole('textbox', { name: 'Markup % Omega-3' }),
    ).not.toHaveAttribute('aria-invalid', 'true')
    expect(sendButton()).toBeEnabled()
  })

  it('disables Markup % and shows "—" for a $0 wholesale cost; price only', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Sample Pack')

    const markup = screen.getByRole('textbox', { name: 'Markup %' })
    expect(markup).toBeDisabled()
    expect(markup).toHaveValue('')
    expect(markup).toHaveAttribute('placeholder', '—')
    expect(markup).toHaveAccessibleDescription(
      'No markup on a $0 cost; enter the price.',
    )
    await fill(user, 'Patient price (each)', '5')
    expect(markup).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))

    expect(
      screen.getByRole('textbox', { name: 'Markup % Sample Pack' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('textbox', { name: 'Markup % Sample Pack' }),
    ).toHaveAttribute('placeholder', '—')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each) Sample Pack' }),
    ).toHaveValue('5.00')
    expect(sendButton()).toBeEnabled()
  })

  it('shows the line processing fee as plain text, in step 2 and in the table', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Vitamin D3')

    await fill(user, 'Qty', '3')
    await fill(user, 'Patient price (each)', '20')

    // 75 bps of the $60.00 line is exactly 45 cents, so rounding up changes nothing. A labelled <output>, not a control.
    const fee = screen.getByRole('status', { name: 'Processing fee (0.75%)' })
    expect(fee).toHaveTextContent('$0.45')
    expect(
      screen.queryByRole('textbox', { name: /Processing fee/ }),
    ).not.toBeInTheDocument()
    await fill(user, 'Patient price (each)', '')
    expect(fee).toBeEmptyDOMElement()
    await fill(user, 'Patient price (each)', '20')

    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(screen.getByTestId('fee-0')).toHaveTextContent('$0.45')
    expect(
      screen.getByRole('columnheader', { name: 'Processing fee (0.75%)' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Platform fee/i)
  })

  it('bounds quantity at 1000 and price at $10,000, in step 2 and in the table', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Omega-3')

    // Step 2: both bounds are inline errors and block Add to order.
    await fill(user, 'Qty', '1001')
    expect(
      screen.getByText('Enter a quantity of at most 1000'),
    ).toBeInTheDocument()
    await fill(user, 'Qty', '1')
    await fill(user, 'Patient price (each)', '10000.01')
    expect(
      screen.getByText('Price can be at most $10,000.00'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(dialog()).toBeInTheDocument()

    await fill(user, 'Patient price (each)', '10000')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    await expectDialogClosed()
    expect(sendButton()).toBeEnabled()

    // Lines table: the same bounds, and Send stays off until they're met.
    await fill(user, 'Qty Omega-3', '1001')
    expect(
      screen.getByRole('textbox', { name: 'Qty Omega-3' }),
    ).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText('Enter a quantity of at most 1000'),
    ).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    await fill(user, 'Qty Omega-3', '2')
    await fill(user, 'Patient price (each) Omega-3', '10000.01')
    expect(
      screen.getByText('Price can be at most $10,000.00'),
    ).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    await fill(user, 'Patient price (each) Omega-3', '10000')
    expect(sendButton()).toBeEnabled()
  })
})
