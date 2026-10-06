import { expect, type Locator, type Page } from '@playwright/test'
import {
  dollarsToCents,
  formatCents,
  moneyIn,
  platformFeeCents,
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
  const row = inventory.getByRole('row', { name: skuFragment })
  await expect(row).toHaveCount(1)
  // The stock cell's name is only the quantity. The name cell also contains
  // digits (for example "120 softgels"), so the name has to be all digits.
  const stockCell = row.getByRole('cell', { name: /^\d+$/ })
  await expect(stockCell).toHaveCount(1)
  const stock = (await stockCell.innerText()).trim()
  return Number(stock)
}

export async function openPatient(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Patients' }).click()
  await page.getByLabel('Search by name or date of birth').fill(name)
  await expect(page.getByText(SINGLE_RESULT)).toBeVisible()
  const row = page.getByRole('row', { name })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

interface AddProductOptions {
  quantity: number
  /**
   * When set, step 2 types this markup. The resulting price is whatever the
   * field shows; it is not computed from a markup formula.
   */
  markupPercent?: string
}

/**
 * Add line -> search by SKU fragment -> step 2. The patient price is read
 * from the field and must be at least the minimum shown. The processing fee
 * must equal 75 bps of that price times the quantity, rounded half up.
 * Quantity other than 1 is typed before adding.
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
  const row = dialog.getByRole('row', { name: skuFragment })
  await expect(row).toHaveCount(1)
  await row.click()

  const price = dialog.getByLabel('Patient price (each)')
  const fee = dialog.getByLabel(/Processing fee/)
  await expect(price).toBeVisible()
  const facts = await dialog.innerText()
  const minimum = dollarsToCents(textAfter(facts, 'Minimum price'))
  const prefilledInput = await price.inputValue()
  const prefilled = dollarsToCents(prefilledInput)
  expect(prefilled).toBeGreaterThanOrEqual(minimum)

  if (options.markupPercent) {
    const feeBefore = dollarsToCents(await fee.inputValue())
    const markup = dialog.getByLabel('Markup %')
    await markup.fill(options.markupPercent)
    await expect(price).not.toHaveValue(prefilledInput)
    await expectFeeForPrice(dialog, price, fee, minimum)
    expect(dollarsToCents(await fee.inputValue())).not.toBe(feeBefore)
    await markup.blur()
  }

  if (options.quantity !== 1) {
    const feeBefore = formatCents(dollarsToCents(await fee.inputValue()))
    await dialog.getByLabel('Qty').fill(String(options.quantity))
    await expect(fee).not.toHaveValue(feeBefore)
    await expectFeeForPrice(dialog, price, fee, minimum)
  }

  await dialog.getByRole('button', { name: 'Add to order' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('row', { name: skuFragment })).toBeVisible()
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
  expect(patientPaysCents).toBe(wholesaleCents + feeCents + marginCents)
  expect(feeCents).toBe(platformFeeCents(patientPaysCents))
  return { patientPaysCents, wholesaleCents, feeCents, marginCents }
}

/**
 * The fee control is a readonly input on this branch, so its text is its
 * value. That text must be 75 bps of the displayed unit price times quantity,
 * rounded half up, and the unit price must stay at or above the minimum.
 */
async function expectFeeForPrice(
  dialog: Locator,
  price: Locator,
  fee: Locator,
  minimumCents: number,
): Promise<void> {
  await expect(async () => {
    const unit = dollarsToCents(await price.inputValue())
    const quantity = Number(
      (await dialog.getByLabel('Qty').inputValue()).trim(),
    )
    expect(unit).toBeGreaterThanOrEqual(minimumCents)
    expect(await fee.inputValue()).toBe(
      formatCents(platformFeeCents(unit * quantity)),
    )
  }).toPass()
}
