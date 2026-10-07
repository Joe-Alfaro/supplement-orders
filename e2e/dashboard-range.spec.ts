import { expect, test } from '@playwright/test'
import { openDashboard, readSalesTiles, signIn } from './flow'

// Read-only: the dashboard opens on This month, and All time is explicit in the
// URL (?range=all) while the default writes nothing.
const PROVIDER = 'Dr. Maya Rivera (Provider)'

test('dashboard defaults to This month and All time lives in the URL', async ({
  page,
}) => {
  await signIn(page, PROVIDER)
  await openDashboard(page)

  const range = page.getByRole('group', { name: 'Date range' })
  await expect(
    range.getByRole('button', { name: 'This month', pressed: true }),
  ).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard$/)
  const monthly = await readSalesTiles(page)

  await range.getByRole('button', { name: 'All time' }).click()

  await expect(page).toHaveURL(/\/dashboard\?range=all$/)
  await expect(
    range.getByRole('button', { name: 'All time', pressed: true }),
  ).toBeVisible()
  await expect(page.getByText('All time', { exact: true }).last()).toBeVisible()
  const lifetime = await readSalesTiles(page)
  // A month is a window inside all time, so it can never exceed it.
  expect(monthly.gmvCents).toBeLessThanOrEqual(lifetime.gmvCents)

  await page.reload()
  await expect(
    page
      .getByRole('group', { name: 'Date range' })
      .getByRole('button', { name: 'All time', pressed: true }),
  ).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\?range=all$/)

  await page
    .getByRole('group', { name: 'Date range' })
    .getByRole('button', { name: 'This month' })
    .click()
  await expect(page).toHaveURL(/\/dashboard$/)
})
