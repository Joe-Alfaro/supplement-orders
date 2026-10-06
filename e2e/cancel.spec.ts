import { expect, type Page, test } from '@playwright/test'
import {
  addProduct,
  AWAITING_ORDERS_LINK,
  openDashboard,
  openOrdersViaDashboard,
  openPatient,
  readSalesTiles,
  readStock,
  signIn,
  signOut,
  type SalesTiles,
} from './flow'

// Owen and Alex are unused by the pay and decline specs. This order is never
// paid, so gross merchandise value, margin, fees, and stock stay put.
const PROVIDER = 'Dr. Owen Brooks (Provider)'
const PATIENT = 'Alex Kim'
const PATIENT_USER = 'Alex Kim (Patient)'
const SKU = 'B-COMPLEX'

test('cancelling an unpaid order leaves the dashboard and stock unchanged', async ({
  page,
}) => {
  const recorded: { baseline: SalesTiles; stock: number } = {
    baseline: { gmvCents: 0, marginCents: 0, feeCents: 0 },
    stock: 0,
  }

  await test.step('provider sends an order and sees it awaiting payment', async () => {
    await signIn(page, PROVIDER)
    await openDashboard(page)
    recorded.baseline = await readSalesTiles(page)
    recorded.stock = await readStock(page, SKU)
    await openPatient(page, PATIENT)
    await page.getByRole('link', { name: 'New order' }).click()
    await addProduct(page, SKU, { quantity: 1 })
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )

    await openDashboard(page)
    await openOrdersViaDashboard(page, AWAITING_ORDERS_LINK, 'pending_payment')
    const waiting = page
      .getByRole('table', { name: 'Orders', exact: true })
      .getByRole('row', { name: PATIENT })
    await expect(waiting).toHaveCount(1)
    await expect(waiting).toContainText('Awaiting payment')
    await waiting.click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )
  })

  await test.step('Keep order leaves the order awaiting payment', async () => {
    await page.getByRole('button', { name: 'Cancel order' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Cancel order' })
    await expect(
      dialog.getByRole('button', { name: 'Keep order' }),
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Cancel order' }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep order' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )
    await expect(
      page.getByRole('button', { name: 'Cancel order' }),
    ).toBeVisible()

    await openDashboard(page)
    await openOrdersViaDashboard(page, AWAITING_ORDERS_LINK, 'pending_payment')
    await expect(awaitingOrder(page)).toHaveCount(1)
  })

  await test.step('confirming cancel removes it and does not move the dashboard', async () => {
    await awaitingOrder(page).click()
    await page.getByRole('button', { name: 'Cancel order' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Cancel order' })
    await dialog.getByRole('button', { name: 'Cancel order' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Cancelled',
    )
    await expect(
      page.getByRole('button', { name: 'Cancel order' }),
    ).toHaveCount(0)

    await openDashboard(page)
    const after = await readSalesTiles(page)
    expect(after).toEqual(recorded.baseline)
    expect(await readStock(page, SKU)).toBe(recorded.stock)
    await openOrdersViaDashboard(page, AWAITING_ORDERS_LINK, 'pending_payment')
    await expect(awaitingOrder(page)).toHaveCount(0)
    await expect(page.getByText('No orders awaiting payment.')).toBeVisible()
  })

  await test.step('patient sees the cancellation and cannot pay', async () => {
    await signOut(page)
    await signIn(page, PATIENT_USER)
    const cancelled = page
      .getByRole('table', { name: 'My orders' })
      .getByRole('row', { name: 'Cancelled' })
    await expect(cancelled).toHaveCount(1)
    await cancelled.click()
    await expect(
      page.getByText('This order was cancelled by your provider.'),
    ).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Cancelled',
    )
    await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0)
  })
})

function awaitingOrder(page: Page) {
  return page
    .getByRole('table', { name: 'Orders', exact: true })
    .getByRole('row', { name: PATIENT })
}
