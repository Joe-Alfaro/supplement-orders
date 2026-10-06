import { expect, test } from '@playwright/test'
import {
  addProduct,
  openDashboard,
  openPatient,
  readSalesTiles,
  signIn,
  signOut,
  type SalesTiles,
} from './flow'

// A different patient and product from the happy path, so a declined payment
// cannot be confused with the order that should succeed.
const PROVIDER = 'Dr. Maya Rivera (Provider)'
const PATIENT = 'Sam Patel'
const PATIENT_USER = 'Sam Patel (Patient)'
const SKU = 'OMEGA3'

test('a simulated gateway failure leaves the order payable and the dashboard unchanged', async ({
  page,
}) => {
  const recorded: { baseline: SalesTiles } = {
    baseline: { gmvCents: 0, marginCents: 0, feeCents: 0 },
  }

  await test.step('provider sends an order and records the dashboard', async () => {
    await signIn(page, PROVIDER)
    await openDashboard(page)
    recorded.baseline = await readSalesTiles(page)
    await openPatient(page, PATIENT)
    await page.getByRole('link', { name: 'New order' }).click()
    await addProduct(page, SKU, { quantity: 1 })
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )
  })

  await test.step('patient decline keeps the order payable', async () => {
    await signOut(page)
    await signIn(page, PATIENT_USER)
    const awaiting = page
      .getByRole('table', { name: 'My orders' })
      .getByRole('row', { name: 'Awaiting payment' })
    await expect(awaiting).toHaveCount(1)
    await awaiting.click()

    await page
      .getByRole('checkbox', { name: 'Simulate gateway failure (dev only)' })
      .check()
    await page.getByRole('button', { name: /^Pay \$/ }).click()

    await expect(page.getByText(/Payment failed/)).toBeVisible()
    await expect(page.getByRole('button', { name: /^Pay \$/ })).toBeEnabled()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )
    await expect(page.getByRole('heading', { name: 'Receipt' })).toHaveCount(0)
  })

  await test.step('dashboard tiles and paid orders are unchanged', async () => {
    await signOut(page)
    await signIn(page, PROVIDER)
    await openDashboard(page)
    const after = await readSalesTiles(page)
    expect(after).toEqual(recorded.baseline)
    await expect(
      page.getByRole('table', { name: 'Paid orders' }).getByRole('row', {
        name: PATIENT,
      }),
    ).toHaveCount(0)
  })
})
