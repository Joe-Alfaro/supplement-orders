import { expect, test } from '@playwright/test'
import {
  addProduct,
  openDashboard,
  openOrdersViaDashboard,
  openPatient,
  PAID_ORDERS_LINK,
  readSalesTiles,
  readSplit,
  readStock,
  signIn,
  signOut,
  type OrderSplit,
  type SalesTiles,
} from './flow'
import { moneyIn } from './money'

// Small supplement_orders_e2e seed: the first provider, their first patient, and two products
// chosen by SKU fragment. Vitamin D3 gets Markup % 300, which is read back
// from the field rather than computed. That label is not on this UI yet, so
// the happy path stays red there. Magnesium stays at its prefilled price
// with quantity 2.
const PROVIDER = 'Dr. Maya Rivera (Provider)'
const PATIENT = 'Jordan Lee'
const PATIENT_USER = 'Jordan Lee (Patient)'
const FIRST_SKU = 'VITD3'
const SECOND_SKU = 'MAG-GLY'
const FIRST_QUANTITY = 1
const SECOND_QUANTITY = 2

test('provider sends an order, the patient pays, and the dashboard matches', async ({
  page,
}) => {
  const recorded: {
    baseline: SalesTiles
    firstStock: number
    secondStock: number
    split: OrderSplit
  } = {
    baseline: { gmvCents: 0, marginCents: 0, feeCents: 0 },
    firstStock: 0,
    secondStock: 0,
    split: {
      patientPaysCents: 0,
      wholesaleCents: 0,
      feeCents: 0,
      marginCents: 0,
    },
  }

  await test.step('provider signs in and records the dashboard baseline', async () => {
    await signIn(page, PROVIDER)
    await openDashboard(page)
    recorded.baseline = await readSalesTiles(page)
    recorded.firstStock = await readStock(page, FIRST_SKU)
    recorded.secondStock = await readStock(page, SECOND_SKU)
  })

  await test.step('provider builds an order and sends it', async () => {
    await openPatient(page, PATIENT)
    await page.getByRole('link', { name: 'New order' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(PATIENT)

    await addProduct(page, FIRST_SKU, {
      quantity: FIRST_QUANTITY,
      markupPercent: '300',
    })
    await addProduct(page, SECOND_SKU, { quantity: SECOND_QUANTITY })

    recorded.split = await readSplit(page)
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText('Draft saved')).toBeVisible()
    const saved = await readSplit(page)
    expect(saved).toEqual(recorded.split)

    await page.getByRole('button', { name: 'Send to patient' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )
  })

  await test.step('patient pays and the receipt shows Paid', async () => {
    await signOut(page)
    await signIn(page, PATIENT_USER)
    await expect(
      page.getByRole('heading', { name: 'My orders', level: 1 }),
    ).toBeVisible()
    const awaiting = page
      .getByRole('table', { name: 'My orders' })
      .getByRole('row', { name: 'Awaiting payment' })
    await expect(awaiting).toHaveCount(1)
    expect(moneyIn(await awaiting.innerText())).toBe(
      recorded.split.patientPaysCents,
    )
    await awaiting.click()

    const total = page.getByRole('table', { name: 'Order total' })
    expect(moneyIn(await total.innerText())).toBe(
      recorded.split.patientPaysCents,
    )
    const main = await page.getByRole('main').innerText()
    expect(main).not.toMatch(/wholesale cost/i)
    expect(main).not.toMatch(/margin/i)
    expect(main).not.toMatch(/markup/i)
    expect(main).not.toMatch(/fee/i)

    await page.getByRole('button', { name: /^Pay \$/ }).click()
    const receipt = page.getByRole('region', { name: 'Receipt' })
    await expect(receipt.getByRole('status')).toContainText('Paid')
    await expect(receipt.getByText(/Payment reference:\s*\S+/)).toBeVisible()

    await page.getByRole('link', { name: 'My Orders' }).click()
    const paid = page
      .getByRole('table', { name: 'My orders' })
      .getByRole('row', { name: 'Paid' })
    await expect(paid).toHaveCount(1)
    expect(moneyIn(await paid.innerText())).toBe(
      recorded.split.patientPaysCents,
    )
    await expect(paid).not.toContainText('Awaiting payment')
  })

  await test.step('provider ledger and dashboard move by exactly this order', async () => {
    await signOut(page)
    await signIn(page, PROVIDER)
    await openPatient(page, PATIENT)
    const order = page
      .getByRole('table', { name: 'Orders' })
      .getByRole('row', { name: 'Paid' })
    await expect(order).toHaveCount(1)
    expect(moneyIn(await order.innerText())).toBe(
      recorded.split.patientPaysCents,
    )
    await order.click()

    const ledger = page.getByRole('table', { name: 'Ledger' })
    const entryNames = ['Wholesale cost', 'Provider margin', 'Processing fee']
    const entryAmounts = await Promise.all(
      entryNames.map(async (name) => {
        const row = ledger.getByRole('row', { name })
        await expect(row).toHaveCount(1)
        return moneyIn(await row.innerText())
      }),
    )
    const entryTotal = entryAmounts.reduce((sum, cents) => sum + cents, 0)
    expect(entryTotal).toBe(recorded.split.patientPaysCents)
    const check = ledger.getByText(/Equals amount paid/)
    await expect(check).toBeVisible()
    expect(moneyIn(await check.innerText())).toBe(
      recorded.split.patientPaysCents,
    )

    await openDashboard(page)
    const after = await readSalesTiles(page)
    expect(after.gmvCents - recorded.baseline.gmvCents).toBe(
      recorded.split.patientPaysCents,
    )
    expect(after.marginCents - recorded.baseline.marginCents).toBe(
      recorded.split.marginCents,
    )
    expect(after.feeCents - recorded.baseline.feeCents).toBe(
      recorded.split.feeCents,
    )
    expect(await readStock(page, FIRST_SKU)).toBe(
      recorded.firstStock - FIRST_QUANTITY,
    )
    expect(await readStock(page, SECOND_SKU)).toBe(
      recorded.secondStock - SECOND_QUANTITY,
    )

    await openOrdersViaDashboard(page, PAID_ORDERS_LINK, 'paid')
    const paidOrder = page
      .getByRole('table', { name: 'Orders', exact: true })
      .getByRole('row', { name: PATIENT })
    await expect(paidOrder).toHaveCount(1)
    await expect(paidOrder).toContainText('Paid')
    expect(moneyIn(await paidOrder.innerText())).toBe(
      recorded.split.patientPaysCents,
    )
  })
})
