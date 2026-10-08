import type {
  ListQuery,
  PatientDto,
  ProductDto,
  ProductPageDto,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { screen, within } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderRoutes } from '../test/renderRoutes'
import { renderWithRouter } from '../test/renderWithRouter'
import { clearNoticeUnlessOn, notice } from '../user'
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
    deleteOrder: vi.fn(),
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

async function renderBuilder(orderId = 'new') {
  const view = await renderWithRouter(OrderBuilderView, {
    path: `/patients/7/orders/${orderId}`,
    props: { patientId: '7', orderId },
  })
  await screen.findByRole('heading', { name: /New order|Draft order/ })
  return view
}

const STOCK_MESSAGE =
  "Some items in this order have a higher quantity than is currently in stock. The patient can pay for what's in stock now; the rest becomes a back-order."

function stockMessage() {
  return screen.queryByText(STOCK_MESSAGE)
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send to patient' })
}

/** A saved draft as the API returns it; only the fields the builder reads matter. */
function draftDetail(
  lines: ProviderOrderDetailDto['lines'],
): ProviderOrderDetailDto {
  return {
    partialPaymentQuote: null,
    paymentInProgress: null,
    backorderStatus: null,
    splitFromOrderId: null,
    backorderOrderId: null,
    blockedByOrderId: null,
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
    lines,
    payment: null,
    journal: null,
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

/** Opens the Edit dialog for a line's product, straight on its pricing step. */
async function openEdit(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Edit ${name}` }))
  await screen.findByRole('heading', { name: `Edit ${name}` })
}

/** Changes a line's pricing through the Edit dialog and saves it. */
async function editLine(
  user: UserEvent,
  name: string,
  fields: { qty?: string; markup?: string; price?: string },
) {
  await openEdit(user, name)
  if (fields.qty !== undefined) await fill(user, 'Qty', fields.qty)
  if (fields.markup !== undefined) await fill(user, 'Markup %', fields.markup)
  if (fields.price !== undefined) {
    await fill(user, 'Patient price (each)', fields.price)
  }
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
}

beforeEach(() => {
  vi.mocked(api.searchProducts)
    .mockReset()
    .mockImplementation(async (query = {}) => productPage(query))
  vi.mocked(api.getPatient).mockResolvedValue(patient)
  vi.mocked(api.getOrder).mockReset()
  vi.mocked(api.createOrder).mockReset()
  vi.mocked(api.deleteOrder).mockReset()
  vi.mocked(api.replaceOrderLines).mockReset()
  vi.mocked(api.sendOrder).mockReset()
  clearNoticeUnlessOn('__reset__')
})

describe('OrderBuilderView', () => {
  it('flags a legacy below-minimum price in the error list and disables Send until edited', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(
      draftDetail([
        {
          payableQuantity: null,
          shortQuantity: null,
          lineId: 909,
          availableQuantity: null,
          productId: 1,
          productName: 'Vitamin D3',
          sku: 'VITD',
          quantity: 1,
          unitPriceCents: 1205,
          lineTotalCents: 1205,
          unitCogsCents: 1200,
          markupBps: 0,
          minUnitPriceCents: 1210,
          stockQuantity: 10,
        },
      ]),
    )
    await renderBuilder('99')

    expect(screen.getByTestId('price-0')).toHaveTextContent('$12.05')
    expect(screen.getByTestId('price-0')).toHaveClass('negative')
    const items = within(
      screen.getByRole('list', { name: 'Order line errors' }),
    ).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Patient price (Vitamin D3) - Price must be at least $12.10',
    ])
    expect(screen.queryByText(/^Min \$/)).not.toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    await editLine(user, 'Vitamin D3', { price: '12.10' })
    await expectDialogClosed()
    expect(screen.getByTestId('price-0')).not.toHaveClass('negative')
    expect(
      screen.queryByRole('list', { name: 'Order line errors' }),
    ).not.toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
  })

  it('shows markup, fee and price as read-only text and keeps Qty an input', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3', { markup: '300' })

    expect(screen.getByTestId('markup-0')).toHaveTextContent('300.00')
    expect(screen.getByTestId('price-0')).toHaveTextContent('$40.30')
    expect(screen.getByTestId('fee-0')).toHaveTextContent('$0.31')
    expect(screen.getByRole('textbox', { name: 'Qty Omega-3' })).toBeVisible()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByText(/^Min \$/)).not.toBeInTheDocument()
  })

  it('shows "—" for an unset price and markup, and 0.00 for the fee', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Vitamin D3', { price: '' })

    expect(screen.getByTestId('markup-0')).toHaveTextContent('—')
    expect(screen.getByTestId('price-0')).toHaveTextContent('—')
    expect(screen.getByTestId('fee-0')).toHaveTextContent('$0.00')
  })

  it('edits a line in the dialog: prefilled, no Back, Save changes updates the line', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    await renderBuilder()
    await addProduct(user, 'Omega-3', { qty: '2' })

    await openEdit(user, 'Omega-3')
    expect(screen.getByRole('textbox', { name: 'Qty' })).toHaveValue('2')
    expect(screen.getByRole('textbox', { name: 'Markup %' })).toHaveValue(
      '0.04',
    )
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('10.08')
    expect(
      screen.queryByRole('button', { name: 'Back' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Add to order' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('searchbox', { name: 'Search products' }),
    ).not.toBeInTheDocument()

    await fill(user, 'Markup %', '300')
    await fill(user, 'Qty', '3')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await expectDialogClosed()
    expect(screen.getAllByTestId('product-0')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Qty Omega-3' })).toHaveValue(
      '3',
    )
    expect(screen.getByTestId('markup-0')).toHaveTextContent('300.00')
    expect(screen.getByTestId('price-0')).toHaveTextContent('$40.30')

    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await vi.waitFor(() =>
      expect(api.replaceOrderLines).toHaveBeenCalledWith(99, [
        { productId: 4, quantity: 3, unitPriceCents: 4030 },
      ]),
    )
  })

  it('discards edits on Cancel', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3')

    await openEdit(user, 'Omega-3')
    await fill(user, 'Markup %', '300')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await expectDialogClosed()
    expect(screen.getByTestId('price-0')).toHaveTextContent('$10.08')
    await openEdit(user, 'Omega-3')
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('10.08')
  })

  it('lists edit-dialog errors in one list and blocks Save changes', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3')

    await openEdit(user, 'Omega-3')
    await fill(user, 'Qty', '0')
    await fill(user, 'Patient price (each)', '10.05')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const items = within(
      within(dialog()).getByRole('list', { name: 'Errors' }),
    ).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Qty - Enter a whole number of 1 or more',
      'Patient price (each) - Price must be at least $10.08',
    ])
    expect(dialog()).toBeInTheDocument()
    expect(screen.getByTestId('price-0')).toHaveTextContent('$10.08')
  })

  it('shows a read-only "Your margin" output after the price, in add and edit modes', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Vitamin D3')

    const margin = screen.getByRole('status', { name: 'Your margin' })
    expect(margin.tagName).toBe('OUTPUT')
    expect(margin).toHaveAttribute('aria-live', 'polite')
    expect(
      screen.queryByRole('textbox', { name: 'Your margin' }),
    ).not.toBeInTheDocument()

    // 3 x $20.00 = $60.00, less 3 x $12.00 cost and the $0.45 line fee.
    await fill(user, 'Qty', '3')
    await fill(user, 'Patient price (each)', '20')
    expect(margin).toHaveTextContent('$23.55')
    expect(margin).not.toHaveClass('negative')

    // Below the minimum the computed value shows, in the negative style.
    await fill(user, 'Patient price (each)', '12')
    expect(margin).toHaveTextContent('-$0.27')
    expect(margin).toHaveClass('negative')

    await fill(user, 'Patient price (each)', '')
    expect(margin).toHaveTextContent('$0.00')
    await fill(user, 'Patient price (each)', '20')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    await expectDialogClosed()

    await openEdit(user, 'Vitamin D3')
    expect(
      screen.getByRole('status', { name: 'Your margin' }),
    ).toHaveTextContent('$23.55')
  })

  it('names Edit and Remove buttons by product', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Magnesium')

    expect(screen.getByRole('button', { name: 'Edit Magnesium' })).toBeVisible()
  })

  it('puts inline Qty errors in one live list below the table, wired by aria-describedby', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3')
    await addProduct(user, 'Magnesium')

    await fill(user, 'Qty Omega-3', '1001')
    await fill(user, 'Qty Magnesium', '9')

    const list = screen.getByRole('list', { name: 'Order line errors' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Qty (Omega-3) - Enter a quantity of at most 1000',
    ])
    // Over stock is not an error and has no per-line item (§4.10b).
    expect(screen.queryByText(/Only 5 in stock/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Qty Magnesium' }),
    ).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('order-line-errors')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    const table = screen.getByRole('table', { name: 'Order lines' })
    expect(table).not.toContainElement(list)
    ;['Qty Omega-3'].forEach((name, index) => {
      const input = screen.getByRole('textbox', { name })
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input.getAttribute('aria-describedby')).toBe(items[index]?.id)
    })

    await fill(user, 'Qty Omega-3', '1')
    await fill(user, 'Qty Magnesium', '1')
    expect(
      screen.queryByRole('list', { name: 'Order line errors' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Qty Omega-3' }),
    ).not.toHaveAttribute('aria-describedby')
  })

  it('saves incomplete lines as a draft and restores them on reload', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    const saved = draftDetail([
      {
        payableQuantity: null,
        shortQuantity: null,
        lineId: 908,
        availableQuantity: null,
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
        payableQuantity: null,
        shortQuantity: null,
        lineId: 907,
        availableQuantity: null,
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

    expect(await screen.findByText('Draft saved')).toBeInTheDocument()
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
    expect(screen.getByTestId('price-0')).toHaveTextContent('—')
    expect(
      screen.getByText('No product (remove this line)'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('price-1')).toHaveTextContent('$25.00')
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

    await editLine(user, 'Magnesium', { price: '20' })
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

    expect(
      await screen.findByText('Qty (Vitamin D3) - Only 3 left'),
    ).toBeInTheDocument()
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
    expect(
      screen.getByRole('textbox', { name: 'Qty Vitamin D3' }),
    ).not.toHaveAttribute('aria-invalid', 'true')
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

  it('disables only products already on the order; out-of-stock products can be added', async () => {
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
    expect(outOfStock).not.toHaveClass('row-unavailable')
    expect(outOfStock).toHaveTextContent('Out of stock')

    await user.click(added)
    expect(
      screen.getByRole('heading', { name: /choose a product/ }),
    ).toBeInTheDocument()

    await user.click(outOfStock)
    expect(
      await screen.findByRole('heading', { name: 'Add Zinc' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Qty' })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(
      screen.getByText(
        'More than the 0 in stock — the rest will be back-ordered.',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(screen.getByTestId('product-1')).toHaveTextContent('Zinc')
    expect(stockMessage()).toBeInTheDocument()
  })

  it('shows one warning above Send only while a line exceeds stock', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Magnesium')
    expect(stockMessage()).not.toBeInTheDocument()

    await fill(user, 'Qty Magnesium', '9')
    expect(screen.getAllByText(STOCK_MESSAGE)).toHaveLength(1)
    expect(
      screen.getByRole('textbox', { name: 'Qty Magnesium' }),
    ).not.toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByRole('textbox', { name: 'Qty Magnesium' }),
    ).not.toHaveAttribute('aria-describedby')

    await fill(user, 'Qty Magnesium', '2')
    expect(stockMessage()).not.toBeInTheDocument()
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
    expect(screen.getByTestId('price-0')).toHaveTextContent('$40.30')
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
      screen.getByText('Patient price (each) - Price must be at least $10.08'),
    ).toBeInTheDocument()
    expect(dialog()).toBeInTheDocument()
    expect(screen.queryByTestId('product-0')).not.toBeInTheDocument()
  })

  it('lists every step 2 error in one live area, in field order', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Omega-3')

    await fill(user, 'Qty', '0')
    await fill(user, 'Patient price (each)', '10.05')
    await fill(user, 'Markup %', 'abc')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))

    const area = within(dialog()).getByRole('list', { name: 'Errors' })
    const items = within(area).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Qty - Enter a whole number of 1 or more',
      'Markup % - Enter a markup of 0 or more, with up to two decimals',
      'Patient price (each) - Price must be at least $10.08',
    ])
    expect(screen.getByTestId('add-product-errors')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    const labels = ['Qty', 'Markup %', 'Patient price (each)']
    labels.forEach((label, index) => {
      const item = items[index]
      const input = screen.getByRole('textbox', { name: label })
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input.getAttribute('aria-describedby')).toContain(item?.id)
      expect(item?.id).toBeTruthy()
    })
    expect(screen.queryByText(/^Min \$/)).not.toBeInTheDocument()
    expect(
      within(dialog()).getByRole('status', { name: 'Processing fee (0.75%)' }),
    ).toHaveTextContent('$0.00')
  })

  it('takes no space for the error area when there are no errors', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await openAddProduct(user)
    await chooseProduct(user, 'Omega-3')

    expect(
      within(dialog()).queryByRole('list', { name: 'Errors' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).not.toHaveAttribute('aria-describedby')
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
  it('names the Qty input by its visible column header and product', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Magnesium')

    // Every word of the accessible name is on screen: the <th> plus the product cell.
    expect(screen.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
    expect(screen.getByTestId('product-0')).toHaveTextContent('Magnesium')
    expect(
      screen.getByRole('textbox', { name: /^Qty Magnesium/ }),
    ).toHaveAccessibleName('Qty Magnesium')
    // Markup and price are text now, not named controls.
    expect(
      screen.queryByRole('textbox', { name: /Markup|Patient price/ }),
    ).not.toBeInTheDocument()
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

  it('warns on Qty over the live stock of a reloaded line, without blocking', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(
      draftDetail([
        {
          payableQuantity: null,
          shortQuantity: null,
          lineId: 906,
          availableQuantity: null,
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
    expect(screen.queryByText(/Only 3 in stock/)).not.toBeInTheDocument()
    expect(stockMessage()).toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
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
    expect(screen.getByTestId('price-0')).toHaveTextContent('$12.50')

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
    expect(screen.getByTestId('price-0')).toHaveTextContent('$8.57')
    expect(sendButton()).toBeEnabled()
  })

  it('accepts markup above 100% and shows it with two decimals', async () => {
    const user = userEvent.setup()
    await renderBuilder()
    await addProduct(user, 'Omega-3', { markup: '300' })

    expect(screen.getByTestId('markup-0')).toHaveTextContent('300.00')
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

    expect(screen.getByTestId('markup-0')).toHaveTextContent('—')
    expect(screen.getByTestId('price-0')).toHaveTextContent('$5.00')
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
    expect(fee).toHaveTextContent('$0.00')
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
      screen.getByText('Qty - Enter a quantity of at most 1000'),
    ).toBeInTheDocument()
    await fill(user, 'Qty', '1')
    await fill(user, 'Patient price (each)', '10000.01')
    expect(
      screen.getByText(
        'Patient price (each) - Price can be at most $10,000.00',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(dialog()).toBeInTheDocument()

    await fill(user, 'Patient price (each)', '10000')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))
    await expectDialogClosed()
    expect(sendButton()).toBeEnabled()

    // Lines table: the qty bound lists in the table error list, and Send stays off.
    await fill(user, 'Qty Omega-3', '1001')
    expect(
      screen.getByRole('textbox', { name: 'Qty Omega-3' }),
    ).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText('Qty (Omega-3) - Enter a quantity of at most 1000'),
    ).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    await fill(user, 'Qty Omega-3', '2')
    expect(sendButton()).toBeEnabled()
  })
})

describe('OrderBuilderView as the one draft page', () => {
  const lines = draftDetail([]).lines

  it('replaces /new with /:orderId on the first save and keeps what was entered', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail(lines))
    const { router } = await renderRoutes('/patients/7/orders/new')
    await screen.findByRole('heading', { name: /New order/ })
    await addProduct(user, 'Vitamin D3', { qty: '3', price: '20' })
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')
    // A line the server would not echo back, to prove the page is not reloaded.
    vi.mocked(api.replaceOrderLines).mockImplementation(async () =>
      draftDetail([
        {
          payableQuantity: null,
          shortQuantity: null,
          lineId: 905,
          availableQuantity: null,
          productId: 1,
          productName: 'Vitamin D3',
          sku: 'VITD',
          quantity: 3,
          unitPriceCents: 2000,
          lineTotalCents: 6000,
          unitCogsCents: 1200,
          markupBps: 4000,
          minUnitPriceCents: 1210,
          stockQuantity: 10,
        },
      ]),
    )

    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByText('Draft saved')).toBeInTheDocument()
    expect(replace).toHaveBeenCalledWith('/patients/7/orders/99')
    expect(push).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/patients/7/orders/99')
    expect(
      screen.getByRole('heading', { name: /Draft order #99/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Qty Vitamin D3' })).toHaveValue(
      '3',
    )
    // No remount: the saved draft was not fetched again.
    expect(api.getOrder).not.toHaveBeenCalled()
    expect(api.createOrder).toHaveBeenCalledTimes(1)
  })

  it('does not create a second order when saving again after the URL changed', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    await renderRoutes('/patients/7/orders/new')
    await screen.findByRole('heading', { name: /New order/ })
    await addProduct(user, 'Vitamin D3', { price: '20' })

    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText('Draft saved')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    await vi.waitFor(() =>
      expect(api.replaceOrderLines).toHaveBeenCalledTimes(2),
    )
    expect(api.createOrder).toHaveBeenCalledTimes(1)
  })

  it('opens a saved draft at /patients/:patientId/orders/:orderId', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(draftDetail([]))
    const { router } = await renderRoutes('/patients/7/orders/99')

    expect(
      await screen.findByRole('heading', { name: /Draft order #99/ }),
    ).toBeInTheDocument()
    expect(router.currentRoute.value.fullPath).toBe('/patients/7/orders/99')
  })

  it.each(['pending_payment', 'paid', 'cancelled'] as const)(
    'redirects a %s order to its detail page',
    async (status) => {
      vi.mocked(api.getOrder).mockResolvedValue({
        ...draftDetail([]),
        status,
      })
      const { router } = await renderRoutes('/patients/7/orders/99')

      await vi.waitFor(() =>
        expect(router.currentRoute.value.fullPath).toBe('/orders/99'),
      )
    },
  )

  it('treats an order of another patient as not found', async () => {
    vi.mocked(api.getOrder).mockResolvedValue({
      ...draftDetail([]),
      patientId: 8,
    })
    const { router } = await renderRoutes('/patients/7/orders/99')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Order not found',
    )
    expect(router.currentRoute.value.fullPath).toBe('/patients/7/orders/99')
    expect(
      screen.queryByRole('button', { name: 'Save draft' }),
    ).not.toBeInTheDocument()
  })
})

describe('OrderBuilderView delete draft', () => {
  const dialogName = 'Delete draft'

  function confirmDialog() {
    return screen.findByRole('alertdialog', { name: dialogName })
  }

  it('is not offered for a new, unsaved order', async () => {
    await renderBuilder()

    expect(
      screen.queryByRole('button', { name: 'Delete draft' }),
    ).not.toBeInTheDocument()
  })

  it('appears once the first save has created the draft', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    await renderBuilder()
    await addProduct(user, 'Vitamin D3', { price: '20' })

    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(
      await screen.findByRole('button', { name: 'Delete draft' }),
    ).toBeInTheDocument()
  })

  it('confirms, deletes once, and returns to the patient with a success toast', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.deleteOrder).mockResolvedValue(undefined)
    const { router } = await renderBuilder('99')

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    const dialog = await confirmDialog()
    expect(dialog).toHaveTextContent(
      "Delete draft order #99 for Jordan Lee? This can't be undone.",
    )
    expect(
      within(dialog).getByRole('button', { name: 'Keep draft' }),
    ).toHaveFocus()
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    )

    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients/7'),
    )
    expect(api.deleteOrder).toHaveBeenCalledTimes(1)
    expect(api.deleteOrder).toHaveBeenCalledWith(99)
    // The toast outlives the route change and shows on the patient page.
    expect(await screen.findByText('Draft deleted')).toBeInTheDocument()
    expect(notice.value).toBeNull()
  })

  it('does nothing on Keep draft', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(draftDetail([]))
    const { router } = await renderBuilder('99')

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    await user.click(
      within(await confirmDialog()).getByRole('button', { name: 'Keep draft' }),
    )

    await vi.waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: dialogName }),
      ).not.toBeInTheDocument(),
    )
    expect(api.deleteOrder).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/patients/7/orders/99')
    expect(notice.value).toBeNull()
  })

  it('shows the error in the banner and stays on the page when delete fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.deleteOrder).mockRejectedValue(
      new api.ApiRequestError(
        409,
        'ORDER_NOT_DRAFT',
        'Only a draft can be deleted',
      ),
    )
    const { router } = await renderBuilder('99')

    await user.click(screen.getByRole('button', { name: 'Delete draft' }))
    await user.click(
      within(await confirmDialog()).getByRole('button', {
        name: 'Delete draft',
      }),
    )

    expect(
      await screen.findByText('Only a draft can be deleted'),
    ).toBeInTheDocument()
    expect(router.currentRoute.value.path).toBe('/patients/7/orders/99')
    expect(notice.value).toBeNull()
  })

  it('is disabled while a save is in flight', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getOrder).mockResolvedValue(draftDetail([]))
    let finish: (order: ProviderOrderDetailDto) => void = () => undefined
    vi.mocked(api.replaceOrderLines).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await renderBuilder('99')
    await addProduct(user, 'Vitamin D3', { price: '20' })

    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeDisabled()
    finish(draftDetail([]))
    await screen.findByText('Draft saved')
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeEnabled()
  })
})

describe('OrderBuilderView success toasts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function addPricedLine() {
    const user = userEvent.setup({ delay: null })
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockResolvedValue(draftDetail([]))
    await renderBuilder()
    await addProduct(user, 'Vitamin D3', { price: '20' })
    return user
  }

  it('confirms a save with a success toast and no inline status text', async () => {
    const user = await addPricedLine()

    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    // PrimeVue Toast announces through role="alert".
    const toast = await screen.findByRole('alert')
    expect(toast).toHaveTextContent('Draft saved')
    expect(toast).toHaveClass('p-toast-message-success')
    expect(screen.queryByText('Draft saved.')).not.toBeInTheDocument()
  })

  it('removes the toast after about 3 seconds', async () => {
    const user = await addPricedLine()
    vi.useFakeTimers()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByText('Draft saved')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(3500)
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
  })

  it('shows errors in the banner, not as a toast', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(api.createOrder).mockResolvedValue(draftDetail([]))
    vi.mocked(api.replaceOrderLines).mockRejectedValue(
      new api.ApiRequestError(500, 'NETWORK', 'Boom'),
    )
    await renderBuilder()
    await addProduct(user, 'Vitamin D3', { price: '20' })

    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    // Exactly one alert: the banner, with no toast beside it.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Boom')
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
  })
})
