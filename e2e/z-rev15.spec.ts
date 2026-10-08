import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import {
  buildAndSend,
  cleanUp,
  heading,
  openPatientOrder,
  openProviderOrder,
  orderIdFrom,
  setStock,
  snapshotStock,
  switchTo,
  totalOf,
} from './backorders'

// Revision 15 (DOMAIN_CONTRACT 15.3). Sorts after the older specs (z-): it
// leaves paid orders behind. Each test declines a partial payment so the
// original stays unpaid while its back-order exists.

const MAYA = 'Dr. Maya Rivera (Provider)'
const MAYA_USER_ID = 1
const JORDAN = 'Jordan Lee'
const JORDAN_USER = 'Jordan Lee (Patient)'
const API = 'http://localhost:3100/api'

let original: Awaited<ReturnType<typeof snapshotStock>>

test.beforeEach(async ({ request }) => {
  original = await snapshotStock(request)
})

test.afterEach(async ({ request }) => {
  await cleanUp(request, original)
})

const LINES = [
  { product: 'VITD', quantity: 2 },
  { product: 'MAG', quantity: 5 },
] as const
/** What the patient can pay while MAG has only 2 units. */
const IN_STOCK = [
  { product: 'VITD', quantity: 2 },
  { product: 'MAG', quantity: 2 },
] as const

async function orderStatus(request: APIRequestContext, id: number) {
  const response = await request.get(`${API}/orders/${id}`, {
    headers: { 'X-User-Id': String(MAYA_USER_ID) },
  })
  if (response.status() === 404) return 'gone'
  return ((await response.json()) as { status: string }).status
}

/**
 * Sends A (MAG short), has the patient pay the in-stock part, and forces the
 * gateway to decline: A is reduced, unpaid, with an Awaiting-stock back-order B.
 */
async function declinedSplit(page: Page, request: APIRequestContext) {
  const aId = await buildAndSend(page, MAYA, JORDAN, LINES)
  await setStock(request, 'VITD', 10)
  await setStock(request, 'MAG', 2)

  await switchTo(page, JORDAN_USER)
  await openPatientOrder(page, aId)
  await page.route('**/api/orders/*/pay', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await route.continue({
      postData: JSON.stringify({ ...body, simulateFailure: true }),
    })
  })
  await page
    .getByRole('button', {
      name: `Pay ${totalOf(IN_STOCK)} for in-stock items`,
    })
    .click()
  await expect(page.getByText(/Payment failed/)).toBeVisible()
  await page.unroute('**/api/orders/*/pay')

  await switchTo(page, MAYA)
  await openProviderOrder(page, aId)
  const link = page.getByRole('link', { name: /^#\d+$/ })
  await expect(link).toHaveCount(1)
  const bId = orderIdFrom((await link.getAttribute('href')) ?? '')
  return { aId, bId }
}

test('a back-order is blocked until its original is paid, then both pay', async ({
  page,
  request,
}) => {
  const { aId, bId } = await declinedSplit(page, request)
  // B's product is back in stock, so B alone could be paid in full.
  await setStock(request, 'MAG', 10)

  await switchTo(page, JORDAN_USER)
  await openPatientOrder(page, bId)
  await expect(page.getByText(/Pay order/)).toContainText(
    `Pay order #${aId} first`,
  )
  await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0)

  await page
    .getByRole('link', { name: `#${aId}`, exact: true })
    .first()
    .click()
  await expect(heading(page)).toContainText(`Order #${aId}`)
  await page.getByRole('button', { name: `Pay ${totalOf(IN_STOCK)}` }).click()
  await expect(heading(page)).toContainText('Paid')

  await openPatientOrder(page, bId)
  await expect(page.getByText(/Pay order/)).toHaveCount(0)
  await page.getByRole('button', { name: /^Pay \$/ }).click()
  await expect(heading(page)).toContainText('Paid')
})

test('cancelling the original cancels its back-order too', async ({
  page,
  request,
}) => {
  const { aId, bId } = await declinedSplit(page, request)

  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Cancel order' })
  await expect(dialog).toContainText('Its back-orders will be cancelled too.')
  await dialog.getByRole('button', { name: 'Cancel order' }).click()

  await expect(heading(page)).toContainText('Cancelled')
  await expect(
    page.getByText(`Back-order #${bId} was cancelled with this order.`),
  ).toBeVisible()
  expect(await orderStatus(request, bId)).toBe('cancelled')
  await openProviderOrder(page, bId)
  await expect(heading(page)).toContainText('Cancelled')
  expect(aId).not.toBe(bId)
})

test('cancel, reopen and delete removes the whole chain', async ({
  page,
  request,
}) => {
  const { aId, bId } = await declinedSplit(page, request)

  await page.getByRole('button', { name: 'Cancel order' }).click()
  await page
    .getByRole('alertdialog', { name: 'Cancel order' })
    .getByRole('button', { name: 'Cancel order' })
    .click()
  await expect(heading(page)).toContainText('Cancelled')

  await page.getByRole('button', { name: 'Reopen as draft' }).click()
  await page
    .getByRole('alertdialog', { name: 'Reopen as draft' })
    .getByRole('button', { name: 'Reopen as draft' })
    .click()
  await expect(page).toHaveURL(/\/patients\/\d+\/orders\/\d+$/)

  await openProviderOrder(page, aId)
  await expect(heading(page)).toContainText('Draft')
  await page.getByRole('button', { name: 'Delete draft' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete draft' })
  await expect(dialog).toContainText(
    'Its linked back-orders will be deleted too.',
  )
  await dialog.getByRole('button', { name: 'Delete draft' }).click()
  await expect(page).toHaveURL(/\/patients\/\d+$/)

  expect(await orderStatus(request, aId)).toBe('gone')
  expect(await orderStatus(request, bId)).toBe('gone')
})
