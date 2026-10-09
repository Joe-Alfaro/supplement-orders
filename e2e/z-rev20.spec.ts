import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import { openDashboard, openPatient, signIn } from './flow'
import { PRODUCTS } from './backorders'

// Revision 20 (DOMAIN_CONTRACT 20.4): a provider's default price starts the
// add-line price, and pricing a line differently never changes it. Maya's
// Omega-3 is used so no other spec's totals change; the default is reset after.

const PROVIDER = 'Dr. Maya Rivera (Provider)'
const PATIENT = 'Jordan Lee'
const MAYA_USER_ID = '1'
const VITD = PRODUCTS.VITD
const API = 'http://localhost:3100/api'

test.afterEach(async ({ request }: { request: APIRequestContext }) => {
  const response = await request.post(
    `${API}/products/${VITD.id}/default-price/reset`,
    { headers: { 'X-User-Id': MAYA_USER_ID, Accept: 'application/json' } },
  )
  expect(response.ok()).toBe(true)
})

async function startOrderAndChooseOmega(page: Page) {
  await openPatient(page, PATIENT)
  await page.getByRole('link', { name: 'New order' }).click()
  await page.getByRole('button', { name: 'Add line' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Search products').fill(VITD.sku)
  const row = dialog
    .getByRole('table', { name: 'Products' })
    .getByRole('row', { name: VITD.sku })
  await expect(row).toHaveCount(1)
  await row.click()
  return dialog
}

function inventoryRow(page: Page) {
  return page
    .getByRole('table', { name: 'Inventory' })
    .getByRole('row', { name: VITD.sku })
}

test('a default price starts every new line, and a line priced differently leaves it alone', async ({
  page,
}) => {
  await signIn(page, PROVIDER)

  await test.step('set the default to $20.00 on the dashboard', async () => {
    await openDashboard(page)
    await page.getByLabel('Search products').fill(VITD.sku)
    await expect(inventoryRow(page)).toHaveCount(1)
    await expect(inventoryRow(page)).toContainText('$8.57')
    await inventoryRow(page)
      .getByRole('button', { name: /^Set default price for / })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Patient price (each)').fill('20')
    await dialog.getByRole('button', { name: 'Save default price' }).click()
    await expect(page.getByText('Default price saved')).toBeVisible()
    await expect(inventoryRow(page)).toContainText('$20.00')
  })

  await test.step('order 1 starts at $20.00; change it to $15.00 and save the draft', async () => {
    const dialog = await startOrderAndChooseOmega(page)
    await expect(dialog.getByLabel('Patient price (each)')).toHaveValue('20.00')
    await dialog.getByLabel('Patient price (each)').fill('15')
    await dialog.getByRole('button', { name: 'Add to order' }).click()
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText('Draft saved')).toBeVisible()
  })

  await test.step('order 2 starts at $20.00 again', async () => {
    const dialog = await startOrderAndChooseOmega(page)
    await expect(dialog.getByLabel('Patient price (each)')).toHaveValue('20.00')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })

  await test.step('the dashboard still shows $20.00', async () => {
    await openDashboard(page)
    await page.getByLabel('Search products').fill(VITD.sku)
    await expect(inventoryRow(page)).toContainText('$20.00')
  })

  await test.step('clean up the draft', async () => {
    await openPatient(page, PATIENT)
    await page.getByRole('row', { name: /Draft/ }).first().click()
    await page.getByRole('button', { name: 'Delete draft' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete draft' })
      .click()
    await expect(page.getByText('Draft deleted')).toBeVisible()
  })
})
