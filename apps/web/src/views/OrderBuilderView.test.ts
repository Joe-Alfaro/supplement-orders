import type { PatientDto, ProductDto } from '@supplement-orders/domain'
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

async function renderBuilder() {
  const result = await renderWithRouter(OrderBuilderView, {
    path: '/patients/7/orders/new',
    props: { patientId: '7' },
  })
  await screen.findByRole('heading', { name: /New order/ })
  return result
}

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
  it('shows a negative margin and disables Send when priced below COGS', async () => {
    await renderBuilder()

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    const price = screen.getByLabelText('Patient price for line 1')
    await fireEvent.update(price, '10')
    await fireEvent.blur(price)

    const margin = screen.getByTestId('margin-0')
    expect(margin.textContent?.trim()).toBe('-$2.00')
    expect(margin.querySelector('.negative')).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Send to patient' }),
    ).toHaveProperty('disabled', true)

    // Pricing at or above COGS re-enables Send.
    await fireEvent.update(price, '20')
    expect(screen.getByTestId('margin-0').textContent?.trim()).toBe('$8.00')
    expect(
      screen.getByRole('button', { name: 'Send to patient' }),
    ).toHaveProperty('disabled', false)
  })

  it('removes a chosen product from the other lines’ options', async () => {
    await renderBuilder()

    await fireEvent.update(screen.getByLabelText('Product for line 1'), '1')
    await fireEvent.click(screen.getByRole('button', { name: 'Add line' }))

    const second = screen.getByLabelText('Product for line 2')
    expect(optionNames(second)).toEqual([
      'Choose a product…',
      'Magnesium (5 in stock)',
    ])
    expect(optionNames(screen.getByLabelText('Product for line 1'))).toContain(
      'Vitamin D3 (10 in stock)',
    )
  })

  it('places a server field error next to the offending input', async () => {
    vi.mocked(api.createOrder).mockResolvedValue({
      id: 99,
    } as Awaited<ReturnType<typeof api.createOrder>>)
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

    const quantity = await screen.findByLabelText('Quantity for line 1')
    expect(await screen.findByText('Only 3 left')).toBeTruthy()
    expect(quantity.getAttribute('aria-invalid')).toBe('true')
  })

  it('shows a field-less EMPTY_ORDER error in the general banner', async () => {
    vi.mocked(api.createOrder).mockResolvedValue({
      id: 99,
    } as Awaited<ReturnType<typeof api.createOrder>>)
    vi.mocked(api.replaceOrderLines).mockResolvedValue({
      id: 99,
      lines: [],
    } as unknown as Awaited<ReturnType<typeof api.replaceOrderLines>>)
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
    await fireEvent.click(
      screen.getByRole('button', { name: 'Send to patient' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('An order needs at least one line')
    expect(container.querySelector('.field-error')).toBeNull()
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull()
  })
})
