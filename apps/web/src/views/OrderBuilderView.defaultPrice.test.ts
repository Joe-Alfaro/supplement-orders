import type { PatientDto } from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { ProviderProductDto } from '../api'
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
    setDefaultPrice: vi.fn(),
    resetDefaultPrice: vi.fn(),
  }
})

// Vitamin D3's minimum price is $12.10; this provider's default is $20.00.
const products: ProviderProductDto[] = [
  {
    id: 1,
    sku: 'VITD',
    name: 'Vitamin D3',
    cogsCents: 1200,
    stockQuantity: 10,
    defaultUnitPriceCents: 2000,
  },
  {
    id: 2,
    sku: 'MAG',
    name: 'Magnesium',
    cogsCents: 1500,
    stockQuantity: 5,
    defaultUnitPriceCents: 1512,
  },
]

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

beforeEach(() => {
  vi.mocked(api.searchProducts).mockReset().mockResolvedValue({
    items: products,
    total: products.length,
    offset: 0,
    limit: 25,
  })
  vi.mocked(api.getPatient).mockResolvedValue(patient)
  vi.mocked(api.setDefaultPrice).mockReset()
  vi.mocked(api.resetDefaultPrice).mockReset()
})

async function chooseProduct(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await renderWithRouter(OrderBuilderView, {
    path: '/patients/7/orders/new',
    props: { patientId: '7', orderId: 'new' },
  })
  await screen.findByRole('heading', { name: /New order/ })
  await user.click(screen.getByRole('button', { name: 'Add line' }))
  await user.click(
    await within(await screen.findByRole('dialog')).findByText(name),
  )
  await screen.findByRole('heading', { name: `Add ${name}` })
}

describe('AddProductDialog starting price', () => {
  it("starts at the provider's default and derives the markup from it", async () => {
    const user = userEvent.setup()
    await chooseProduct(user, 'Vitamin D3')

    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('20.00')
    // (2000 - 1200 fee-adjusted) is well above 0% markup.
    expect(screen.getByRole('textbox', { name: 'Markup %' })).not.toHaveValue(
      '0.00',
    )
    expect(screen.getByLabelText('Your margin')).toHaveTextContent('$7.85')
  })

  it('starts at the minimum when the default is the minimum', async () => {
    const user = userEvent.setup()
    await chooseProduct(user, 'Magnesium')

    expect(
      screen.getByRole('textbox', { name: 'Patient price (each)' }),
    ).toHaveValue('15.12')
  })

  it('adding at a different price never writes a default', async () => {
    const user = userEvent.setup()
    await chooseProduct(user, 'Vitamin D3')

    const price = screen.getByRole('textbox', { name: 'Patient price (each)' })
    await user.clear(price)
    await user.type(price, '15')
    await user.click(screen.getByRole('button', { name: 'Add to order' }))

    expect(api.setDefaultPrice).not.toHaveBeenCalled()
    expect(api.resetDefaultPrice).not.toHaveBeenCalled()
  })
})
