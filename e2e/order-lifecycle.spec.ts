import { expect, type Page, test } from '@playwright/test'
import { addProduct, openPatient, signIn, signOut } from './flow'

// Owen's patients, so this stays off Maya's pay and decline orders. Alex's
// order is left awaiting payment so the status filter still has a row after
// the paid order is unchecked.
const PROVIDER = 'Dr. Owen Brooks (Provider)'
const PATIENT = 'Riley Chen'
const PATIENT_USER = 'Riley Chen (Patient)'
const OTHER = 'Alex Kim'
const DRAFT_SKU = 'B-COMPLEX'
const OTHER_SKU = 'PROBIO'

test('a draft can be deleted, and a cancelled order can be reopened and paid', async ({
  page,
}) => {
  await test.step('provider saves a draft and confirms delete', async () => {
    await signIn(page, PROVIDER)
    await openPatient(page, OTHER)
    await page.getByRole('link', { name: 'New order' }).click()
    await addProduct(page, OTHER_SKU, { quantity: 1 })
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )

    await openPatient(page, PATIENT)
    await page.getByRole('link', { name: 'New order' }).click()
    await addProduct(page, DRAFT_SKU, { quantity: 1 })
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText('Draft saved.')).toBeVisible()

    await openOrders(page)
    await showOnly(page, 'Draft')
    const draft = ordersTable(page).getByRole('row', { name: PATIENT })
    await expect(draft).toHaveCount(1)
    await draft.click()
    await confirmAction(page, 'Delete draft')
    await expect(page.getByText('Draft deleted')).toBeVisible()
    await expect(
      page.getByText('No orders for this patient yet.'),
    ).toBeVisible()

    await openOrders(page)
    await showOnly(page, 'Draft')
    await expect(
      ordersTable(page).getByRole('row', { name: PATIENT }),
    ).toHaveCount(0)
    await expect(page.getByText('No draft orders.')).toBeVisible()
  })

  await test.step('Orders defaults to Awaiting payment and lists the sent order', async () => {
    await openPatient(page, PATIENT)
    await page.getByRole('link', { name: 'New order' }).click()
    await addProduct(page, DRAFT_SKU, { quantity: 1 })
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )

    await openOrders(page)
    // One selected status uses that status's date column. "Sent" is Awaiting
    // payment; the closed combobox keeps its value in a sibling, not its input.
    await expect(
      ordersTable(page).getByRole('columnheader', { name: 'Sent' }),
    ).toBeVisible()
    const awaiting = ordersTable(page).getByRole('row', { name: PATIENT })
    await expect(awaiting).toHaveCount(1)
    await expect(awaiting).toContainText('Awaiting payment')
    await expect(
      ordersTable(page).getByRole('row', { name: OTHER }),
    ).toHaveCount(1)
  })

  await test.step('cancel, then the Cancelled filter lists it', async () => {
    await ordersTable(page).getByRole('row', { name: PATIENT }).click()
    await confirmAction(page, 'Cancel order')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Cancelled',
    )

    await openOrders(page)
    await showOnly(page, 'Cancelled')
    const cancelled = ordersTable(page).getByRole('row', { name: PATIENT })
    await expect(cancelled).toHaveCount(1)
    await expect(cancelled).toContainText('Cancelled')
  })

  await test.step('reopen as a draft, send again, and the patient pays', async () => {
    await ordersTable(page).getByRole('row', { name: PATIENT }).click()
    await confirmAction(page, 'Reopen as draft')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Draft order',
    )
    await expect(page.getByRole('heading', { level: 1 })).toContainText(PATIENT)
    await expect(
      page
        .getByRole('table', { name: 'Order lines' })
        .getByRole('row', { name: DRAFT_SKU }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Awaiting payment',
    )

    await signOut(page)
    await signIn(page, PATIENT_USER)
    const awaiting = page
      .getByRole('table', { name: 'My orders' })
      .getByRole('row', { name: 'Awaiting payment' })
    await expect(awaiting).toHaveCount(1)
    await awaiting.click()
    await page.getByRole('button', { name: /^Pay \$/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Paid')
  })

  await test.step('unchecking Paid hides that order and leaves the others', async () => {
    await signOut(page)
    await signIn(page, PROVIDER)
    await openOrders(page)
    await openStatusList(page)
    await page.getByRole('checkbox', { name: 'Select all' }).click()
    const paid = ordersTable(page).getByRole('row', { name: PATIENT })
    await expect(paid).toHaveCount(1)
    await expect(paid).toContainText('Paid')
    await toggleStatus(page, 'Paid')
    await expect(
      ordersTable(page).getByRole('row', { name: PATIENT }),
    ).toHaveCount(0)
    // Cancel may have left this patient a second, non-paid order. Any remaining
    // row is enough, and a count assertion retries while the table reloads.
    await expect(
      ordersTable(page).getByRole('row', { name: OTHER }),
    ).not.toHaveCount(0)
  })

  await test.step('Latest order status Paid shows the patient who just paid', async () => {
    await page.getByRole('link', { name: 'Patients' }).click()
    await expect(
      page.getByRole('heading', { name: 'Patients', level: 1 }),
    ).toBeVisible()
    await page.getByRole('combobox', { name: 'Latest order status' }).click()
    await page.getByRole('option', { name: 'Paid', exact: true }).click()
    const patients = page.getByRole('table', { name: 'Patients' })
    await expect(patients.getByRole('row', { name: PATIENT })).toHaveCount(1)
    await expect(patients.getByRole('row', { name: OTHER })).toHaveCount(0)
  })
})

function ordersTable(page: Page) {
  return page.getByRole('table', { name: 'Orders', exact: true })
}

async function openOrders(page: Page) {
  await page.getByRole('link', { name: 'Orders', exact: true }).click()
  // The Orders view is loaded on first visit, and the address stays put until
  // that chunk is ready. Give the cold compile longer than the default wait.
  await expect(page).toHaveURL(/\/orders(?:\?|$)/, { timeout: 30_000 })
  await expect(
    page.getByRole('heading', { name: 'Orders', level: 1 }),
  ).toBeVisible()
}

/** The closed Status control shows the default; open it and keep only one status. */
async function showOnly(page: Page, status: string) {
  await toggleStatus(page, status)
  await toggleStatus(page, 'Awaiting payment')
}

/**
 * PrimeVue's MultiSelect combobox is a hidden input covered by the selected
 * labels, so a click never lands on it. ArrowDown opens the list, which is
 * how the control works from the keyboard.
 */
async function openStatusList(page: Page) {
  const combobox = page.getByRole('combobox', { name: 'Status' })
  if ((await combobox.getAttribute('aria-expanded')) !== 'true') {
    await combobox.focus()
    await page.keyboard.press('ArrowDown')
  }
  await expect(page.getByRole('listbox')).toBeVisible()
}

async function toggleStatus(page: Page, status: string) {
  await openStatusList(page)
  await page.getByRole('option', { name: status, exact: true }).click()
}

async function confirmAction(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name })
  await expect(
    dialog
      .getByRole('button', { name: 'Keep draft' })
      .or(dialog.getByRole('button', { name: 'Keep order' }))
      .or(dialog.getByRole('button', { name: 'Keep cancelled' })),
  ).toBeVisible()
  await dialog.getByRole('button', { name, exact: true }).click()
  await expect(dialog).toBeHidden()
}
