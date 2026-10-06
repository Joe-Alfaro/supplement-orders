import { expect, type Locator, type Page } from '@playwright/test'
import {
  centsToInput,
  dollarsToCents,
  formatCents,
  marginBps,
  moneyIn,
  platformFeeCents,
  priceFromMarginCents,
  textAfter,
} from './money'

export interface SalesTiles {
  gmvCents: number
  marginCents: number
  feeCents: number
}

export interface OrderSplit {
  patientPaysCents: number
  wholesaleCents: number
  feeCents: number
  marginCents: number
}

const SINGLE_RESULT = 'Showing 1\u20131 of 1'

/** Signs in through the User combobox. `optionName` is the visible option label. */
export async function signIn(page: Page, optionName: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('User').click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

export async function openDashboard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeVisible()
}

/**
 * The stat tiles are PrimeVue cards: the label is not an accessible name for
 * the amount, so the amounts are read from the Sales region's text.
 */
export async function readSalesTiles(page: Page): Promise<SalesTiles> {
  const sales = page.getByRole('region', { name: 'Sales' })
  await expect(sales.getByText('GMV', { exact: true })).toBeVisible()
  const text = await sales.innerText()
  return {
    gmvCents: dollarsToCents(textAfter(text, 'GMV')),
    marginCents: dollarsToCents(textAfter(text, 'Your margin earned')),
    feeCents: dollarsToCents(textAfter(text, 'Processing fees')),
  }
}

/** Stock on hand for one SKU, after the inventory search has narrowed to it. */
export async function readStock(
  page: Page,
  skuFragment: string,
): Promise<number> {
  const inventory = page.getByRole('region', { name: 'Inventory' })
  await inventory.getByLabel('Search products').fill(skuFragment)
  await expect(inventory.getByText(SINGLE_RESULT)).toBeVisible()
  const row = inventory.getByRole('row').filter({ hasText: skuFragment })
  await expect(row).toHaveCount(1)
  const cells = row.getByRole('cell')
  const stock = (await cells.last().innerText()).trim()
  if (!/^\d+$/.test(stock)) {
    throw new Error(`Stock for ${skuFragment} was "${stock}"`)
  }
  return Number(stock)
}

export async function openPatient(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Patients' }).click()
  await page.getByLabel('Search by name or date of birth').fill(name)
  await expect(page.getByText(SINGLE_RESULT)).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

interface AddProductOptions {
  quantity: number
  /** When set, step 2 types this margin and checks the price and fee. */
  marginPercent?: string
}

/**
 * Add line -> search by SKU fragment -> step 2. The price starts at the
 * minimum shown on the dialog. A margin edit must change both the price and
 * the processing fee. Quantity other than 1 is typed before adding.
 */
export async function addProduct(
  page: Page,
  skuFragment: string,
  options: AddProductOptions,
): Promise<void> {
  await page.getByRole('button', { name: 'Add line' }).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: /choose a product/ }),
  ).toBeVisible()
  await dialog.getByLabel('Search products').fill(skuFragment)
  await expect(dialog.getByText(SINGLE_RESULT)).toBeVisible()
  const row = dialog.getByRole('row').filter({ hasText: skuFragment })
  await expect(row).toHaveCount(1)
  await row.click()

  const price = dialog.getByLabel('Patient price (each)')
  const fee = dialog.getByLabel(/Processing fee/)
  await expect(price).toBeVisible()
  const facts = await dialog.innerText()
  const minimum = dollarsToCents(textAfter(facts, 'Minimum price'))
  const prefilled = dollarsToCents(await price.inputValue())
  expect(prefilled).toBe(minimum)

  if (options.marginPercent) {
    const feeBefore = dollarsToCents(await fee.inputValue())
    const margin = dialog.getByLabel('Margin %')
    await margin.fill(options.marginPercent)
    const wholesale = dollarsToCents(textAfter(facts, 'Wholesale cost'))
    const expectedPrice = priceFromMarginCents(
      wholesale,
      marginBps(options.marginPercent),
    )
    await expect(price).toHaveValue(centsToInput(expectedPrice))
    const quantity = Number(
      (await dialog.getByLabel('Qty').inputValue()).trim(),
    )
    const expectedFee = platformFeeCents(expectedPrice * quantity)
    await expect(fee).toHaveValue(formatCents(expectedFee))
    expect(expectedPrice).not.toBe(prefilled)
    expect(expectedFee).not.toBe(feeBefore)
    await margin.blur()
  }

  if (options.quantity !== 1) {
    const feeBefore = dollarsToCents(await fee.inputValue())
    await dialog.getByLabel('Qty').fill(String(options.quantity))
    const unit = dollarsToCents(await price.inputValue())
    const expectedFee = platformFeeCents(unit * options.quantity)
    await expect(fee).toHaveValue(formatCents(expectedFee))
    expect(expectedFee).not.toBe(feeBefore)
  }

  await dialog.getByRole('button', { name: 'Add to order' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('row').filter({ hasText: skuFragment }),
  ).toBeVisible()
}

export async function readSplit(page: Page): Promise<OrderSplit> {
  const summary = page.getByRole('table', { name: 'Split summary' })
  await expect(summary).toBeVisible()
  async function rowCents(label: string): Promise<number> {
    const row = summary.getByRole('row', { name: new RegExp(`^${label}`) })
    return moneyIn(await row.innerText())
  }
  const patientPaysCents = await rowCents('Patient pays')
  const wholesaleCents = await rowCents('Wholesale cost')
  const feeCents = await rowCents('Processing fee')
  const marginCents = await rowCents('Your margin')
  expect(patientPaysCents - wholesaleCents - feeCents).toBe(marginCents)
  return { patientPaysCents, wholesaleCents, feeCents, marginCents }
}

/** Ledger table is the one whose footer says the entries were checked. */
export function ledgerTable(page: Page): Locator {
  return page.getByRole('table').filter({ hasText: 'Total of entries' })
}
