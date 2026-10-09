import type { DashboardDto, ProductDto } from '@supplement-orders/domain'
import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { ApiRequestError } from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import DashboardView from './DashboardView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getDashboard: vi.fn(),
    searchProducts: vi.fn(),
    setDefaultPrice: vi.fn(),
    resetDefaultPrice: vi.fn(),
  }
})

const dashboard: DashboardDto = {
  soldByProduct: [],
  owedToYouCents: 0,
  gmvCents: 0,
  providerMarginCents: 0,
  platformFeeCents: 0,
  range: {
    preset: 'month',
    from: '2026-10-01',
    to: '2026-10-07',
    timeZone: 'UTC',
  },
}

// $12.00 cost: the minimum price is 1200 + ceil(75 * 1200 / 9925) = $12.10.
function vitaminD(defaultUnitPriceCents: number): ProductDto {
  return {
    id: 1,
    sku: 'VITD',
    name: 'Vitamin D3',
    cogsCents: 1200,
    stockQuantity: 10,
    defaultUnitPriceCents,
  }
}

function serve(row: ProductDto) {
  vi.mocked(api.searchProducts).mockResolvedValue({
    items: [row],
    total: 1,
    offset: 0,
    limit: 25,
  })
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await renderWithRouter(DashboardView)
  await screen.findByText('Vitamin D3')
  await user.click(
    screen.getByRole('button', { name: 'Set default price for Vitamin D3' }),
  )
  return screen.findByRole('dialog', {
    name: 'Set default price for Vitamin D3',
  })
}

function priceInput() {
  return screen.getByRole('textbox', { name: 'Patient price (each)' })
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  value: string,
) {
  const field = screen.getByRole('textbox', { name })
  await user.clear(field)
  if (value !== '') await user.type(field, value)
}

beforeEach(() => {
  vi.mocked(api.getDashboard).mockReset().mockResolvedValue(dashboard)
  vi.mocked(api.setDefaultPrice).mockReset()
  vi.mocked(api.resetDefaultPrice).mockReset()
  serve(vitaminD(2000))
})

describe('DashboardView default prices', () => {
  it('shows each product default in a Default price column', async () => {
    await renderWithRouter(DashboardView)
    await screen.findByText('Vitamin D3')

    expect(
      screen.getByRole('columnheader', { name: 'Default price' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '$20.00' })).toBeInTheDocument()
  })

  it('opens at the current default with the add-line pricing fields and no Qty', async () => {
    const user = userEvent.setup()
    const dialog = await openDialog(user)

    expect(priceInput()).toHaveValue('20.00')
    expect(within(dialog).getByLabelText('Markup %')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Processing fee/)).toHaveTextContent(
      '$0.15',
    )
    expect(within(dialog).getByLabelText('Your margin')).toHaveTextContent(
      '$7.85',
    )
    expect(
      screen.queryByRole('textbox', { name: 'Qty' }),
    ).not.toBeInTheDocument()
    expect(within(dialog).getByText('$12.10')).toBeInTheDocument()
  })

  it('links Markup % and the price both ways', async () => {
    const user = userEvent.setup()
    await openDialog(user)

    await fill(user, 'Patient price (each)', '15')
    const markup = screen.getByRole('textbox', { name: 'Markup %' })
    expect(markup).not.toHaveValue('')
    const fromPrice = (markup as HTMLInputElement).value

    await fill(user, 'Markup %', '0')
    expect(priceInput()).toHaveValue('12.10')
    expect(fromPrice).not.toBe('0.00')
  })

  it('lists a below-minimum price and does not save it', async () => {
    const user = userEvent.setup()
    await openDialog(user)

    await fill(user, 'Patient price (each)', '12.00')
    await user.click(screen.getByRole('button', { name: 'Save default price' }))

    expect(
      await screen.findByText(
        'Patient price (each) - Price must be at least $12.10',
      ),
    ).toBeInTheDocument()
    expect(api.setDefaultPrice).not.toHaveBeenCalled()
  })

  it('requires a price', async () => {
    const user = userEvent.setup()
    await openDialog(user)

    await fill(user, 'Patient price (each)', '')
    await user.click(screen.getByRole('button', { name: 'Save default price' }))

    expect(
      await screen.findByText('Patient price (each) - Enter a price'),
    ).toBeInTheDocument()
    expect(api.setDefaultPrice).not.toHaveBeenCalled()
  })

  it('saves in cents, toasts, closes and updates the row', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setDefaultPrice).mockResolvedValue(vitaminD(1500))
    await openDialog(user)

    await fill(user, 'Patient price (each)', '15')
    await user.click(screen.getByRole('button', { name: 'Save default price' }))

    expect(api.setDefaultPrice).toHaveBeenCalledWith(1, 1500)
    expect(await screen.findByText('Default price saved')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('cell', { name: '$15.00' })).toBeInTheDocument()
  })

  it('shows a server error in the dialog and stays open', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setDefaultPrice).mockRejectedValue(
      new ApiRequestError(400, 'VALIDATION_ERROR', 'Price too low'),
    )
    await openDialog(user)

    await user.click(screen.getByRole('button', { name: 'Save default price' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Price too low')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('resets to the minimum only after confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(api.resetDefaultPrice).mockResolvedValue(vitaminD(1210))
    await openDialog(user)

    await user.click(screen.getByRole('button', { name: 'Reset to minimum' }))
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Reset to minimum',
    })
    expect(api.resetDefaultPrice).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }))

    expect(api.resetDefaultPrice).toHaveBeenCalledWith(1)
    expect(await screen.findByText('Default price reset')).toBeInTheDocument()
    expect(
      await screen.findByRole('cell', { name: '$12.10' }),
    ).toBeInTheDocument()
  })

  it('keeps the default when the reset confirmation is declined', async () => {
    const user = userEvent.setup()
    await openDialog(user)

    await user.click(screen.getByRole('button', { name: 'Reset to minimum' }))
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Reset to minimum',
    })
    await user.click(within(confirm).getByRole('button', { name: 'Keep' }))

    expect(api.resetDefaultPrice).not.toHaveBeenCalled()
  })

  it('cancel discards edits', async () => {
    const user = userEvent.setup()
    await openDialog(user)

    await fill(user, 'Patient price (each)', '15')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(api.setDefaultPrice).not.toHaveBeenCalled()
    expect(screen.getByRole('cell', { name: '$20.00' })).toBeInTheDocument()
  })
})
