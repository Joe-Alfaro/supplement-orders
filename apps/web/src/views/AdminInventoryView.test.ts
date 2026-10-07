import type { AdminProductDto, AdminProductPageDto } from '@supplement-orders/domain'
import { fireEvent, screen, waitFor, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import AdminInventoryView from './AdminInventoryView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    searchAdminProducts: vi.fn(),
    incrementProductStock: vi.fn(),
    setProductStock: vi.fn(),
  }
})

function product(id: number, name: string, stock = 40): AdminProductDto {
  return { id, name, wholesaleCostCents: 850, stockQuantity: stock }
}

function pageOf(
  items: AdminProductDto[],
  total = items.length,
  offset = 0,
): AdminProductPageDto {
  return { items, total, offset, limit: 25 }
}

const firstPage = Array.from({ length: 25 }, (_, index) =>
  product(index + 1, index === 0 ? 'Vitamin D3' : `Product ${index + 1}`),
)

async function renderPage(path = '/admin/inventory') {
  const view = await renderWithRouter(AdminInventoryView, { path })
  await screen.findByRole('table', { name: 'Inventory' })
  return view
}

const stockInput = () =>
  screen.getByRole<HTMLInputElement>('spinbutton', {
    name: 'Stock for Vitamin D3',
  })

/** Replaces the stock the way a person does: select all, then type. */
async function typeStock(keys: string) {
  await userEvent.click(stockInput())
  stockInput().select()
  await userEvent.keyboard(keys)
}
const add = (by: number) =>
  screen.getByRole('button', { name: `Add ${by} to Vitamin D3` })

/** Controls when a mocked request settles. */
function deferred<T>() {
  const handle: {
    resolve: (value: T) => void
    reject: (reason: unknown) => void
  } = { resolve: () => {}, reject: () => {} }
  const promise = new Promise<T>((resolve, reject) => {
    handle.resolve = resolve
    handle.reject = reject
  })
  return { promise, ...handle }
}

beforeEach(() => {
  vi.mocked(api.searchAdminProducts)
    .mockReset()
    .mockResolvedValue(pageOf([product(1, 'Vitamin D3'), product(2, 'Zinc')]))
  vi.mocked(api.incrementProductStock).mockReset()
  vi.mocked(api.setProductStock).mockReset()
})

describe('AdminInventoryView table', () => {
  it('lists product, wholesale cost and stock', async () => {
    await renderPage()

    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent),
    ).toEqual(['Product', 'Wholesale cost', 'Stock'])
    const row = screen.getByRole('row', { name: /Vitamin D3/ })
    expect(within(row).getByText('$8.50')).toBeInTheDocument()
    expect(stockInput()).toHaveValue('40')
  })

  it('shows loading, then an error with retry', async () => {
    const pending = deferred<AdminProductPageDto>()
    vi.mocked(api.searchAdminProducts).mockReturnValueOnce(pending.promise)
    await renderWithRouter(AdminInventoryView, { path: '/admin/inventory' })
    expect(await screen.findByText('Loading…')).toBeInTheDocument()

    pending.reject(new Error('boom'))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(
      await screen.findByRole('table', { name: 'Inventory' }),
    ).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    vi.mocked(api.searchAdminProducts).mockResolvedValue(pageOf([]))
    await renderWithRouter(AdminInventoryView, { path: '/admin/inventory' })

    expect(await screen.findByRole('status')).toHaveTextContent('No products.')
  })

  it('reads ?q= and ?page= from the URL', async () => {
    vi.mocked(api.searchAdminProducts).mockResolvedValue(
      pageOf([product(1, 'Vitamin D3')], 60, 25),
    )
    await renderPage('/admin/inventory?q=vit&page=2')

    expect(api.searchAdminProducts).toHaveBeenCalledWith({
      q: 'vit',
      offset: 25,
      limit: 25,
    })
    expect(
      screen.getByRole('searchbox', { name: 'Search products' }),
    ).toHaveValue('vit')
  })

  it('writes page changes to the URL', async () => {
    vi.mocked(api.searchAdminProducts).mockResolvedValue(pageOf(firstPage, 60))
    const { router } = await renderPage()

    await userEvent.click(screen.getByRole('button', { name: /next page/i }))

    await waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ page: '2' }),
    )
    expect(api.searchAdminProducts).toHaveBeenLastCalledWith({
      q: '',
      offset: 25,
      limit: 25,
    })
  })

  it('writes a search to the URL and resets the page', async () => {
    const { router } = await renderPage('/admin/inventory?page=2')

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search products' }),
      'zinc',
    )

    await waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ q: 'zinc' }),
    )
    expect(api.searchAdminProducts).toHaveBeenLastCalledWith({
      q: 'zinc',
      offset: 0,
      limit: 25,
    })
  })
})

describe('AdminInventoryView increments', () => {
  it.each([1, 10, 100])(
    '+%i calls the endpoint and shows the returned stock',
    async (by) => {
      vi.mocked(api.incrementProductStock).mockResolvedValue(
        product(1, 'Vitamin D3', 40 + by),
      )
      await renderPage()

      await userEvent.click(add(by))

      expect(api.incrementProductStock).toHaveBeenCalledWith(1, by)
      await waitFor(() => expect(stockInput()).toHaveValue(String(40 + by)))
    },
  )

  it("disables only that row's buttons while its request is in flight", async () => {
    const pending = deferred<AdminProductDto>()
    vi.mocked(api.incrementProductStock).mockReturnValue(pending.promise)
    await renderPage()

    await userEvent.click(add(10))

    expect(add(1)).toBeDisabled()
    expect(add(10)).toBeDisabled()
    expect(add(100)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add 1 to Zinc' })).toBeEnabled()

    pending.resolve(product(1, 'Vitamin D3', 50))
    await waitFor(() => expect(add(10)).toBeEnabled())
  })

  it('announces a failed increment and leaves stock unchanged', async () => {
    vi.mocked(api.incrementProductStock).mockRejectedValue(
      new api.ApiRequestError(
        400,
        'VALIDATION_ERROR',
        'Stock cannot exceed 1000000',
        'by',
      ),
    )
    await renderPage()

    await userEvent.click(add(100))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Stock cannot exceed 1000000',
    )
    expect(stockInput()).toHaveValue('40')
    expect(add(100)).toBeEnabled()
  })
})

describe('AdminInventoryView editing stock', () => {
  it('shows Save and Cancel only when the value differs from the saved one', async () => {
    await renderPage()
    expect(
      screen.queryByRole('button', { name: /^Save/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Cancel/ }),
    ).not.toBeInTheDocument()

    await typeStock('55')
    expect(
      screen.getByRole('button', { name: 'Save stock for Vitamin D3' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Cancel editing Vitamin D3' }),
    ).toBeInTheDocument()

    await typeStock('40')
    expect(
      screen.queryByRole('button', { name: /^Save/ }),
    ).not.toBeInTheDocument()
  })

  it("disables the row's increments while it has unsaved edits", async () => {
    await renderPage()

    await typeStock('55')

    expect(add(1)).toBeDisabled()
    expect(add(10)).toBeDisabled()
    expect(add(100)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add 1 to Zinc' })).toBeEnabled()
  })

  it('saves with the last loaded value as expectedStockQuantity', async () => {
    vi.mocked(api.setProductStock).mockResolvedValue(
      product(1, 'Vitamin D3', 55),
    )
    await renderPage()

    await typeStock('55')
    await userEvent.click(
      screen.getByRole('button', { name: 'Save stock for Vitamin D3' }),
    )

    expect(api.setProductStock).toHaveBeenCalledWith(1, {
      stockQuantity: 55,
      expectedStockQuantity: 40,
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /^Save/ }),
      ).not.toBeInTheDocument(),
    )
    expect(stockInput()).toHaveValue('55')
    expect(add(1)).toBeEnabled()
  })

  it('uses the new saved value as expected on the next save', async () => {
    vi.mocked(api.setProductStock)
      .mockResolvedValueOnce(product(1, 'Vitamin D3', 55))
      .mockResolvedValueOnce(product(1, 'Vitamin D3', 60))
    await renderPage()

    await typeStock('55{Enter}')
    await waitFor(() => expect(api.setProductStock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull(),
    )
    await typeStock('60{Enter}')

    await waitFor(() =>
      expect(api.setProductStock).toHaveBeenLastCalledWith(1, {
        stockQuantity: 60,
        expectedStockQuantity: 55,
      }),
    )
  })

  it('shows Save for a plain input event (autofill, scripted input)', async () => {
    await renderPage()

    await fireEvent.update(stockInput(), '77')

    expect(
      screen.getByRole('button', { name: 'Save stock for Vitamin D3' }),
    ).toBeInTheDocument()
  })

  it('Enter saves', async () => {
    vi.mocked(api.setProductStock).mockResolvedValue(
      product(1, 'Vitamin D3', 7),
    )
    await renderPage()

    await typeStock('7{Enter}')

    await waitFor(() =>
      expect(api.setProductStock).toHaveBeenCalledWith(1, {
        stockQuantity: 7,
        expectedStockQuantity: 40,
      }),
    )
  })

  it('Enter does nothing when the value is unchanged', async () => {
    await renderPage()

    await userEvent.click(stockInput())
    await userEvent.keyboard('{Enter}')

    expect(api.setProductStock).not.toHaveBeenCalled()
  })

  it('Escape cancels the edit', async () => {
    await renderPage()

    await typeStock('55{Escape}')

    expect(stockInput()).toHaveValue('40')
    expect(
      screen.queryByRole('button', { name: /^Save/ }),
    ).not.toBeInTheDocument()
    expect(api.setProductStock).not.toHaveBeenCalled()
    expect(add(1)).toBeEnabled()
  })

  it('Cancel restores the saved value', async () => {
    await renderPage()

    await typeStock('55')
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel editing Vitamin D3' }),
    )

    expect(stockInput()).toHaveValue('40')
    expect(
      screen.queryByRole('button', { name: /^Save/ }),
    ).not.toBeInTheDocument()
  })

  it('does not accept values above 1,000,000 or negatives', async () => {
    await renderPage()

    await typeStock('2000000')
    await userEvent.tab()
    expect(stockInput()).toHaveValue('1000000')

    await typeStock('-5')
    await userEvent.tab()
    expect(stockInput()).toHaveValue('5')
  })

  it('shows the conflict message, updates the saved value and keeps the typed one', async () => {
    vi.mocked(api.setProductStock).mockRejectedValue(
      new api.ApiRequestError(
        409,
        'STOCK_CHANGED',
        'Stock changed',
        undefined,
        33,
      ),
    )
    await renderPage()

    await typeStock('55{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Stock changed to 33 since you loaded it. Review and save again.',
    )
    expect(stockInput()).toHaveValue('55')
    expect(
      screen.getByRole('button', { name: 'Save stock for Vitamin D3' }),
    ).toBeInTheDocument()

    vi.mocked(api.setProductStock).mockResolvedValue(
      product(1, 'Vitamin D3', 55),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Save stock for Vitamin D3' }),
    )
    await waitFor(() =>
      expect(api.setProductStock).toHaveBeenLastCalledWith(1, {
        stockQuantity: 55,
        expectedStockQuantity: 33,
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    )
  })

  it('announces other save failures and keeps the edit', async () => {
    vi.mocked(api.setProductStock).mockRejectedValue(
      new api.ApiRequestError(0, 'NETWORK', 'Could not reach the server'),
    )
    await renderPage()

    await typeStock('55{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server',
    )
    expect(stockInput()).toHaveValue('55')
  })
})
