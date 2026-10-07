import { expect, test, type Page } from '@playwright/test'
import { signIn } from './flow'

const ADMIN = 'Ada Admin (Admin)'
const PROVIDER = 'Dr. Owen Brooks (Provider)'
const PRODUCT = 'Methylated B-Complex (60 caps)'

// Changes stock by +10 and then sets it to a new value. Other specs read stock
// relative to their own baseline, so a shifted quantity does not affect them.

async function openInventory(page: Page) {
  await expect(page).toHaveURL(/\/admin\/inventory$/)
  await page
    .getByRole('searchbox', { name: 'Search products' })
    .fill('B-Complex')
  await expect(page.getByRole('row').filter({ hasText: PRODUCT })).toHaveCount(
    1,
  )
}

const stockInput = (page: Page) =>
  page.getByRole('spinbutton', { name: `Stock for ${PRODUCT}` })

test('admin adds stock, edits it directly, and the change survives a reload', async ({
  page,
}) => {
  await signIn(page, ADMIN)
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link'),
  ).toHaveText(['Inventory'])
  await openInventory(page)

  const before = Number(await stockInput(page).inputValue())

  await test.step('+10 shows the returned stock', async () => {
    await page.getByRole('button', { name: `Add 10 to ${PRODUCT}` }).click()
    await expect(stockInput(page)).toHaveValue(String(before + 10))
  })

  const target = before + 25
  await test.step('typing a new value reveals Save, and Save persists it', async () => {
    const save = page.getByRole('button', {
      name: `Save stock for ${PRODUCT}`,
    })
    await expect(save).toHaveCount(0)
    await stockInput(page).fill(String(target))
    await expect(save).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Add 1 to ${PRODUCT}` }),
    ).toBeDisabled()
    await save.click()
    await expect(save).toHaveCount(0)
    await expect(stockInput(page)).toHaveValue(String(target))
  })

  await test.step('the saved value is still there after a reload', async () => {
    await page.reload()
    await expect(page.getByRole('table', { name: 'Inventory' })).toBeVisible()
    await page
      .getByRole('searchbox', { name: 'Search products' })
      .fill('B-Complex')
    await expect(stockInput(page)).toHaveValue(String(target))
  })
})

test('a provider cannot reach the admin inventory', async ({ page }) => {
  await signIn(page, PROVIDER)

  await page.goto('/admin/inventory')

  await expect(page).toHaveURL(/\/patients$/)
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
      name: 'Inventory',
    }),
  ).toHaveCount(0)
})
