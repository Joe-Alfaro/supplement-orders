import type {
  PatientDto,
  ProductDto,
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
]

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

function optionNames(select: HTMLElement) {
  return within(select)
    .getAllByRole('option')
    .map((option) => option.textContent?.trim())
}

beforeEach(() => {
  vi.mocked(api.listProducts).mockResolvedValue(products)
  vi.mocked(api.getPatient).mockResolvedValue(patient)
})

describe('OrderBuilderView', () => {
  it('shows a red Min hint and disables Send when priced below the minimum', async () => {
    await renderBuilder()

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
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

  it('removes a chosen product from the other lines’ options', async () => {
    await renderBuilder()

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    await fireEvent.click(screen.getByRole('button', { name: 'Add line' }))

    expect(optionNames(screen.getByLabelText('Product for line 2'))).toEqual([
      'Choose a product…',
      'Magnesium (5 in stock)',
    ])
    expect(optionNames(screen.getByLabelText('Product for line 1'))).toContain(
      'Vitamin D3 (10 in stock)',
    )
  })

  it('links Margin % and Patient price both ways without overwriting the typed field', async () => {
    await renderBuilder()
    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')

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

    // Line 1: product but no price. Line 2: price but no product.
    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    await fireEvent.update(screen.getByLabelText('Quantity for line 1'), '2')
    await fireEvent.click(screen.getByRole('button', { name: 'Add line' }))
    await fireEvent.update(
      screen.getByLabelText('Patient price for line 2'),
      '25',
    )
    expect(sendButton()).toHaveProperty('disabled', true)

    const save = screen.getByRole('button', { name: 'Save draft' })
    expect(save).toHaveProperty('disabled', false)
    await fireEvent.click(save)

    expect(await screen.findByText('Draft saved.')).toBeTruthy()
    expect(api.replaceOrderLines).toHaveBeenCalledWith(99, [
      { productId: 1, quantity: 2, unitPriceCents: null },
      { productId: null, quantity: 1, unitPriceCents: 2500 },
    ])

    // Reload the builder for the saved draft: both incomplete lines come back.
    first.unmount()
    await renderBuilder('99')
    expect(inputValue('Product for line 1')).toBe('1')
    expect(inputValue('Quantity for line 1')).toBe('2')
    expect(inputValue('Patient price for line 1')).toBe('')
    expect(inputValue('Product for line 2')).toBe('')
    expect(inputValue('Patient price for line 2')).toBe('25.00')
    expect(sendButton()).toHaveProperty('disabled', true)
  })

  it('keeps Send disabled until every line is complete and at its minimum', async () => {
    await renderBuilder()
    expect(sendButton()).toHaveProperty('disabled', true)

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    await fireEvent.update(
      screen.getByLabelText('Patient price for line 1'),
      '20',
    )
    expect(sendButton()).toHaveProperty('disabled', false)

    await fireEvent.click(screen.getByRole('button', { name: 'Add line' }))
    expect(sendButton()).toHaveProperty('disabled', true)

    await fireEvent.update(screen.getByLabelText('Product for line 2'), '2')
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

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    await fireEvent.update(
      screen.getByLabelText('Patient price for line 1'),
      '20',
    )
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

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    await fireEvent.update(
      screen.getByLabelText('Patient price for line 1'),
      '20',
    )
    await fireEvent.click(sendButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('An order needs at least one line')
    expect(container.querySelector('.field-error')).toBeNull()
  })
})
