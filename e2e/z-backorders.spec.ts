import { expect, test, type Page } from '@playwright/test'
import {
  addStock,
  buildAndSend,
  cleanUp,
  heading,
  openPatientOrder,
  openProviderOrder,
  payInStockItems,
  SENT_ORDER_URL,
  setStock,
  snapshotStock,
  switchTo,
  totalOf,
  type ProductKey,
} from './backorders'
import { openDashboard, readSalesTiles } from './flow'
import { dollarsToCents } from './money'

// Revision 14 (DOMAIN_CONTRACT 14.9). This file sorts last (z-) on purpose: the
// older specs assume the seed patients have no orders yet, and these leave paid
// ones behind. Stock is set exactly through the admin API
// after the order is sent: the add-product dialog will not offer a product that
// has no stock. Each test leaves no open orders and restores the stock it found.

const MAYA = 'Dr. Maya Rivera (Provider)'
const OWEN = 'Dr. Owen Brooks (Provider)'
const JORDAN = 'Jordan Lee'
const SAM = 'Sam Patel'
const RILEY = 'Riley Chen'
const asPatient = (name: string) => `${name} (Patient)`

let original: Awaited<ReturnType<typeof snapshotStock>>

test.beforeEach(async ({ request }) => {
  original = await snapshotStock(request)
})

test.afterEach(async ({ request }) => {
  await cleanUp(request, original)
})

function stockLevels(
  request: Parameters<typeof setStock>[0],
  levels: Partial<Record<ProductKey, number>>,
) {
  return Object.entries(levels).reduce(async (previous, [key, value]) => {
    await previous
    await setStock(request, key as ProductKey, value)
  }, Promise.resolve() as Promise<void>)
}

function lineRows(page: Page) {
  return page.getByRole('table', { name: 'Order lines' })
}

async function expectLines(
  page: Page,
  present: Array<[string, number]>,
  absent: string[] = [],
) {
  const table = lineRows(page)
  await Promise.all(
    present.map(async ([name, quantity]) => {
      const row = table.getByRole('row', { name: new RegExp(name) })
      await expect(row).toHaveCount(1)
      await expect(
        row.getByRole('cell', { name: String(quantity), exact: true }),
      ).toHaveCount(1)
    }),
  )
  await Promise.all(
    absent.map((name) =>
      expect(table.getByRole('row', { name: new RegExp(name) })).toHaveCount(0),
    ),
  )
}

test('1. one line with no stock: the patient pays for the in-stock lines and the back-order holds the rest', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'VITD', quantity: 2 },
    { product: 'MAG', quantity: 3 },
    { product: 'OMEGA', quantity: 1 },
  ] as const
  const id = await buildAndSend(page, MAYA, JORDAN, lines)
  await stockLevels(request, { VITD: 10, MAG: 10, OMEGA: 0 })

  await switchTo(page, asPatient(JORDAN))
  await openPatientOrder(page, id)
  await expect(page.getByText('Some items have limited stock.')).toBeVisible()
  await expect(page.getByText('Out of stock', { exact: true })).toBeVisible()
  const inStock = totalOf(lines.slice(0, 2))
  const backorderId = await payInStockItems(page, inStock)

  await test.step('the original is paid with only the in-stock lines', async () => {
    await expect(heading(page)).toContainText('Paid')
    await expectLines(
      page,
      [
        ['Vitamin D3', 2],
        ['Magnesium', 3],
      ],
      ['Omega-3'],
    )
  })

  await test.step('the patient sees the back-order, linked both ways', async () => {
    await page
      .getByRole('region', { name: 'Receipt' })
      .getByRole('link', { name: `#${backorderId}` })
      .click()
    await expect(heading(page)).toContainText(`Order #${backorderId}`)
    await expect(heading(page)).toContainText('Awaiting stock')
    await expectLines(page, [['Omega-3', 1]], ['Vitamin D3', 'Magnesium'])
    await expect(page.getByRole('button', { name: /Pay/ })).toHaveCount(0)
    await expect(page.getByText(/Back-order of order/)).toBeVisible()
    await page.getByRole('link', { name: `#${id}` }).click()
    await expect(heading(page)).toContainText(`Order #${id}`)
  })

  await test.step('the provider sees the same two orders and links', async () => {
    await switchTo(page, MAYA)
    await openProviderOrder(page, id)
    await expect(heading(page)).toContainText('Paid')
    await expect(page.getByText(/Partially fulfilled/)).toBeVisible()
    await page.getByRole('link', { name: `#${backorderId}` }).click()
    await expect(heading(page)).toContainText('Awaiting stock')
    await expect(page.getByText(/Back-order of order/)).toBeVisible()
    await expect(page.getByRole('link', { name: `#${id}` })).toBeVisible()
  })
})

test('2. partial stock on several lines: the patient pays the available quantities', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'VITD', quantity: 5 },
    { product: 'MAG', quantity: 4 },
  ] as const
  const id = await buildAndSend(page, MAYA, SAM, lines)
  await stockLevels(request, { VITD: 3, MAG: 1 })

  await switchTo(page, asPatient(SAM))
  await openPatientOrder(page, id)
  await expect(page.getByText('Only 3 of 5 in stock')).toBeVisible()
  await expect(page.getByText('Only 1 of 4 in stock')).toBeVisible()
  const backorderId = await payInStockItems(
    page,
    totalOf([
      { product: 'VITD', quantity: 3 },
      { product: 'MAG', quantity: 1 },
    ]),
  )
  await expectLines(page, [
    ['Vitamin D3', 3],
    ['Magnesium', 1],
  ])

  await openPatientOrder(page, backorderId)
  // Both products are at zero now, so the shortfall waits for stock.
  await expect(heading(page)).toContainText('Awaiting stock')
  await expectLines(page, [
    ['Vitamin D3', 2],
    ['Magnesium', 3],
  ])
  await expect(page.getByRole('table', { name: 'Order total' })).toContainText(
    totalOf([
      { product: 'VITD', quantity: 2 },
      { product: 'MAG', quantity: 3 },
    ]),
  )
  await expect(page.getByRole('button', { name: /Pay/ })).toHaveCount(0)

  await switchTo(page, MAYA)
  await openProviderOrder(page, backorderId)
  await expect(heading(page)).toContainText('Awaiting stock')
})

test('3. mixed order: no stock, partial stock and full stock; the dashboard counts only what was paid', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'PROBIO', quantity: 2 },
    { product: 'OMEGA', quantity: 4 },
    { product: 'BCOMP', quantity: 1 },
  ] as const
  const id = await buildAndSend(page, MAYA, JORDAN, lines)
  await stockLevels(request, { PROBIO: 0, OMEGA: 3, BCOMP: 5 })

  await openDashboard(page)
  const before = await readSalesTiles(page)

  await switchTo(page, asPatient(JORDAN))
  await openPatientOrder(page, id)
  const paidLines = [
    { product: 'OMEGA', quantity: 3 },
    { product: 'BCOMP', quantity: 1 },
  ] as const
  const paidTotal = totalOf(paidLines)
  const backorderId = await payInStockItems(page, paidTotal)
  await expectLines(
    page,
    [
      ['Omega-3', 3],
      ['B-Complex', 1],
    ],
    ['Probiotic'],
  )

  await openPatientOrder(page, backorderId)
  await expect(heading(page)).toContainText('Awaiting stock')
  await expectLines(
    page,
    [
      ['Probiotic', 2],
      ['Omega-3', 1],
    ],
    ['B-Complex'],
  )

  await test.step('the provider dashboard grew by exactly the amount paid', async () => {
    await switchTo(page, MAYA)
    await openDashboard(page)
    const after = await readSalesTiles(page)
    expect(after.gmvCents - before.gmvCents).toBe(dollarsToCents(paidTotal))
  })
})

test('4. provider sends with low stock: warning, confirmation, then the patient sees limited stock', async ({
  page,
  request,
}) => {
  await setStock(request, 'MAG', 3)
  await switchTo(page, MAYA)
  await page.getByRole('link', { name: 'Patients' }).click()
  await page.getByLabel('Search by name or date of birth').fill(SAM)
  await page.getByRole('row', { name: SAM }).click()
  await page.getByRole('link', { name: 'New order' }).click()

  await page.getByRole('button', { name: 'Add line' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Search products').fill('MAG-GLY')
  await dialog.getByRole('row', { name: 'MAG-GLY' }).click()
  await dialog.getByLabel('Qty').fill('5')
  await expect(dialog.getByText(/Only 3 in stock/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Add to order' }).click()
  await expect(dialog).toBeHidden()

  await test.step('the table warns, and saving is not blocked', async () => {
    await expect(
      page.getByRole('list', { name: 'Order line warnings' }),
    ).toContainText('Only 3 in stock')
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText('Draft saved')).toBeVisible()
  })

  await test.step('Back to order does not send', async () => {
    await page.getByRole('button', { name: 'Send to patient' }).click()
    const confirm = page.getByRole('dialog', {
      name: 'Send with limited stock?',
    })
    await expect(confirm).toContainText('5 requested, 3 in stock')
    await confirm.getByRole('button', { name: 'Back to order' }).click()
    await expect(confirm).toBeHidden()
    await expect(page).toHaveURL(/\/patients\/\d+\/orders\/\d+$/)
  })

  await test.step('Send anyway sends', async () => {
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await page
      .getByRole('dialog', { name: 'Send with limited stock?' })
      .getByRole('button', { name: 'Send anyway' })
      .click()
    await expect(page).toHaveURL(SENT_ORDER_URL)
    await expect(heading(page)).toContainText('Awaiting payment')
  })

  const id = Number(/(\d+)$/.exec(page.url())?.[1])
  await switchTo(page, asPatient(SAM))
  await openPatientOrder(page, id)
  await expect(page.getByText('Some items have limited stock.')).toBeVisible()
  await expect(page.getByText('Only 3 of 5 in stock')).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: `Pay ${totalOf([{ product: 'MAG', quantity: 3 }])} for in-stock items`,
    }),
  ).toBeVisible()
})

test('5. a fully out-of-stock order waits, then is paid in full after a restock', async ({
  page,
  request,
}) => {
  const lines = [{ product: 'OMEGA', quantity: 2 }] as const
  const id = await buildAndSend(page, MAYA, JORDAN, lines)
  await stockLevels(request, { OMEGA: 0 })

  await switchTo(page, asPatient(JORDAN))
  await openPatientOrder(page, id)
  await expect(heading(page)).toContainText('Awaiting stock')
  await expect(
    page.getByText(
      "These items are out of stock. You'll be able to pay once they're back in stock.",
    ),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Pay/ })).toHaveCount(0)

  await addStock(request, 'OMEGA', 10)
  await page.reload()
  await expect(heading(page)).toContainText('Awaiting payment')
  const total = totalOf(lines)
  await page.getByRole('button', { name: `Pay ${total}`, exact: true }).click()
  const receipt = page.getByRole('region', { name: 'Receipt' })
  await expect(receipt.getByRole('status')).toContainText(`Paid ${total}`)
  await expect(receipt.getByRole('link')).toHaveCount(0)
  await expect(page.getByText(/moved to order/)).toHaveCount(0)
})

test('6. back-order chain: paying a back-order partly creates a third order, linked in sequence', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'VITD', quantity: 3 },
    { product: 'MAG', quantity: 2 },
    { product: 'OMEGA', quantity: 2 },
  ] as const
  const a = await buildAndSend(page, MAYA, SAM, lines)
  await stockLevels(request, { VITD: 3, MAG: 0, OMEGA: 0 })

  await switchTo(page, asPatient(SAM))
  await openPatientOrder(page, a)
  const b = await payInStockItems(
    page,
    totalOf([{ product: 'VITD', quantity: 3 }]),
  )

  // Restock only the Magnesium of the back-order: it becomes partly payable.
  await setStock(request, 'MAG', 2)
  await openPatientOrder(page, b)
  await expect(heading(page)).toContainText('Awaiting payment')
  const c = await payInStockItems(
    page,
    totalOf([{ product: 'MAG', quantity: 2 }]),
  )
  await expect(page.getByText(/Back-order of order/)).toBeVisible()
  await expect(page.getByRole('link', { name: `#${a}` })).toBeVisible()

  await openPatientOrder(page, c)
  await expect(heading(page)).toContainText('Awaiting stock')
  await expectLines(page, [['Omega-3', 2]])
  await expect(page.getByRole('link', { name: `#${b}` })).toBeVisible()

  await switchTo(page, MAYA)
  await openProviderOrder(page, a)
  await expect(page.getByRole('link', { name: `#${b}` })).toBeVisible()
  await openProviderOrder(page, b)
  await expect(page.getByRole('link', { name: `#${a}` })).toBeVisible()
  await expect(page.getByRole('link', { name: `#${c}` })).toBeVisible()
  await openProviderOrder(page, c)
  await expect(page.getByRole('link', { name: `#${b}` })).toBeVisible()
})

test('7. a back-order can be cancelled but never edited or reopened', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'VITD', quantity: 1 },
    { product: 'OMEGA', quantity: 1 },
  ] as const
  const id = await buildAndSend(page, MAYA, JORDAN, lines)
  await stockLevels(request, { VITD: 5, OMEGA: 0 })
  await switchTo(page, asPatient(JORDAN))
  await openPatientOrder(page, id)
  const backorderId = await payInStockItems(
    page,
    totalOf([{ product: 'VITD', quantity: 1 }]),
  )

  await switchTo(page, MAYA)
  await openProviderOrder(page, backorderId)
  const noEditing = async () => {
    await expect(page.getByRole('button', { name: /Reopen/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Edit/ })).toHaveCount(0)
  }
  await noEditing()

  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Cancel order' })
  await dialog.getByRole('button', { name: 'Cancel order' }).click()
  await expect(heading(page)).toContainText('Cancelled')
  await noEditing()
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(
    0,
  )
})

test('8. a stale quote is refreshed without charging, and the next pay succeeds', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'VITD', quantity: 2 },
    { product: 'MAG', quantity: 3 },
  ] as const
  const id = await buildAndSend(page, MAYA, JORDAN, lines)
  await stockLevels(request, { VITD: 5, MAG: 1 })

  await switchTo(page, asPatient(JORDAN))
  await openPatientOrder(page, id)
  const first = totalOf([
    { product: 'VITD', quantity: 2 },
    { product: 'MAG', quantity: 1 },
  ])
  const button = page.getByRole('button', {
    name: `Pay ${first} for in-stock items`,
  })
  await expect(button).toBeVisible()

  // Another patient takes the last Magnesium after this page loaded.
  await setStock(request, 'MAG', 0)
  await button.click()

  await expect(
    page.getByText('Stock changed; please review the updated amounts.'),
  ).toBeVisible()
  const second = totalOf([{ product: 'VITD', quantity: 2 }])
  await expect(
    page.getByRole('button', { name: `Pay ${second} for in-stock items` }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Receipt' })).toHaveCount(0)

  const backorderId = await payInStockItems(page, second)
  expect(backorderId).toBeGreaterThan(id)
})

test('9. filters: Awaiting stock lists the back-order, and My orders tags both orders', async ({
  page,
  request,
}) => {
  const lines = [
    { product: 'VITD', quantity: 2 },
    { product: 'OMEGA', quantity: 3 },
  ] as const
  const id = await buildAndSend(page, OWEN, RILEY, lines)
  await stockLevels(request, { VITD: 5, OMEGA: 0 })
  await switchTo(page, asPatient(RILEY))
  await openPatientOrder(page, id)
  const backorderId = await payInStockItems(
    page,
    totalOf([{ product: 'VITD', quantity: 2 }]),
  )

  await test.step('the provider Orders tab filters to Awaiting stock', async () => {
    await switchTo(page, OWEN)
    await page.getByRole('link', { name: 'Orders', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Orders', level: 1 }),
    ).toBeVisible()
    const combobox = page.getByRole('combobox', { name: 'Status' })
    await combobox.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('listbox')).toBeVisible()
    const selectAll = page.getByRole('checkbox', { name: 'Select all' })
    await selectAll.click()
    await expect(selectAll).not.toBeChecked()
    await page
      .getByRole('option', { name: 'Awaiting stock', exact: true })
      .click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/status=awaiting_stock/)

    const table = page.getByRole('table', { name: 'Orders', exact: true })
    await expect(
      table.getByRole('row', { name: new RegExp(`#${backorderId}\\b`) }),
    ).toHaveCount(1)
    await expect(
      table.getByRole('row', { name: new RegExp(`#${id}\\b`) }),
    ).toHaveCount(0)
  })

  await test.step('the patient My orders shows both orders with their tags', async () => {
    await switchTo(page, asPatient(RILEY))
    await page.getByRole('link', { name: 'My Orders' }).click()
    const table = page.getByRole('table', { name: 'My orders' })
    const paidTotal = totalOf([{ product: 'VITD', quantity: 2 }])
    const waitingTotal = totalOf([{ product: 'OMEGA', quantity: 3 }])
    await expect(
      table.getByRole('row').filter({ hasText: paidTotal }),
    ).toContainText('Paid')
    await expect(
      table.getByRole('row').filter({ hasText: waitingTotal }),
    ).toContainText('Awaiting stock')
  })
})
