import { expect, type Locator, type Page } from '@playwright/test'
import {
  dollarsToCents,
  formatCents,
  moneyIn,
  percentToBps,
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

export const PAID_ORDERS_LINK = 'See paid orders →'
export const AWAITING_ORDERS_LINK = 'See orders awaiting payment →'

/**
 * A dashboard link opens the Orders tab already filtered. The address does not
 * change until that view's chunk has loaded, which is slow on a cold start.
 */
export async function openOrdersViaDashboard(
  page: Page,
  linkName: string,
  status: string,
): Promise<void> {
  await page
    .getByRole('link', { name: linkName, exact: true })
    .click({ timeout: 10_000 })
  await expect(page).toHaveURL(new RegExp(`/orders\\?status=${status}$`), {
    timeout: 30_000,
  })
  await expect(
    page.getByRole('heading', { name: 'Orders', level: 1 }),
  ).toBeVisible()
}

/** Each stat tile is a group named by its label. The amount is the money inside. */
export async function readSalesTiles(page: Page): Promise<SalesTiles> {
  async function groupCents(name: string): Promise<number> {
    const tile = page.getByRole('group', { name, exact: true })
    await expect(tile).toBeVisible()
    return moneyIn(await tile.innerText())
  }
  return {
    gmvCents: await groupCents('GMV'),
    marginCents: await groupCents('Your margin earned'),
    feeCents: await groupCents('Processing fees'),
  }
}

/** The all-time payable balance tile on the provider dashboard. */
export async function readOwedToYou(page: Page): Promise<number> {
  const tile = page.getByRole('group', { name: 'Owed to you (all time)' })
  await expect(tile).toBeVisible()
  return moneyIn(await tile.innerText())
}

/** Stock on hand for one SKU, after the inventory search has narrowed to it. */
export async function readStock(
  page: Page,
  skuFragment: string,
): Promise<number> {
  const inventory = page.getByRole('region', { name: 'Inventory' })
  await inventory.getByLabel('Search products').fill(skuFragment)
  await expect(inventory.getByText(SINGLE_RESULT)).toBeVisible()
  const table = inventory.getByRole('table', { name: 'Inventory' })
  const row = table.getByRole('row', { name: skuFragment })
  await expect(row).toHaveCount(1)
  // The quantity cell's name is only digits. The product name also contains
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
  const row = page
    .getByRole('table', { name: 'Patients' })
    .getByRole('row', { name })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

interface AddProductOptions {
  quantity: number
  /**
   * When set, step 2 types this into Markup %. The resulting price is whatever
   * the field shows; it is not computed from a formula. The label is not on
   * this UI yet, so this branch stays red until it lands.
   */
  markupPercent?: string
}

/**
 * Add line -> search by SKU fragment -> step 2. The patient price is read
 * from the field and must be at least the minimum shown. The processing fee
 * must equal 75 bps of that price times the quantity, rounded up.
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
  const row = dialog
    .getByRole('table', { name: 'Products' })
    .getByRole('row', { name: skuFragment })
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
    const typedMarkup = options.markupPercent
    const markup = dialog.getByLabel('Markup %')
    await expect(markup).toBeVisible()
    const wholesale = dollarsToCents(textAfter(facts, 'Wholesale cost'))
    const displayedFee = dollarsToCents(await shownFee(fee))
    expect(prefilled).toBe(wholesale + displayedFee)
    const feeBefore = await shownFee(fee)
    await markup.fill(typedMarkup)
    await expect(price).not.toHaveValue(prefilledInput)
    await expectFeeForPrice(dialog, price, fee, minimum)
    expect(await shownFee(fee)).not.toBe(feeBefore)
    await markup.blur()
    // Blur may format "300" as "300.00". Either way it stays the typed percent.
    await expect(async () => {
      expect(percentToBps(await markup.inputValue())).toBe(
        percentToBps(typedMarkup),
      )
    }).toPass()
    await expectFeeForPrice(dialog, price, fee, minimum)
  }

  if (options.quantity !== 1) {
    const feeBefore = await shownFee(fee)
    await dialog.getByLabel('Qty').fill(String(options.quantity))
    await expect(fee).not.toHaveText(feeBefore)
    await expectFeeForPrice(dialog, price, fee, minimum)
  }

  await dialog.getByRole('button', { name: 'Add to order' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page
      .getByRole('table', { name: 'Order lines' })
      .getByRole('row', { name: skuFragment }),
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
  expect(patientPaysCents).toBe(wholesaleCents + feeCents + marginCents)
  expect(feeCents).toBe(platformFeeCents(patientPaysCents))
  return { patientPaysCents, wholesaleCents, feeCents, marginCents }
}

/** The step-2 fee is a labelled output. Its text is not an input value. */
async function shownFee(fee: Locator): Promise<string> {
  return (await fee.innerText()).trim()
}

/**
 * The fee text must be 75 bps of the displayed unit price times quantity,
 * rounded up, and the unit price must stay at or above the minimum.
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
    expect(await shownFee(fee)).toBe(
      formatCents(platformFeeCents(unit * quantity)),
    )
  }).toPass()
}
