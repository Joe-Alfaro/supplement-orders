import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import pg from 'pg'
import { e2eDatabaseUrl } from '../apps/api/src/db/databases'
import {
  buildAndSend,
  cleanUp,
  heading,
  openPatientOrder,
  openProviderOrder,
  payInStockItems,
  setStock,
  snapshotStock,
  switchTo,
  totalOf,
} from './backorders'

// Revision 18 (DOMAIN_CONTRACT 18.1, 18.2). Sorts last (z-): it leaves paid
// orders behind.

const MAYA = 'Dr. Maya Rivera (Provider)'
const JORDAN = 'Jordan Lee'
const JORDAN_USER = 'Jordan Lee (Patient)'
const ADMIN = 'Ada Admin (Admin)'

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

async function declinePartialPayment(page: Page, amount: string) {
  await page.route('**/api/orders/*/pay', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await route.continue({
      postData: JSON.stringify({ ...body, simulateFailure: true }),
    })
  })
  await page
    .getByRole('button', { name: `Pay ${amount} for in-stock items` })
    .click()
  await expect(page.getByText(/Payment failed/)).toBeVisible()
  await page.unroute('**/api/orders/*/pay')
}

test('partial payment still works after the original is cancelled and reopened', async ({
  page,
  request,
}: {
  page: Page
  request: APIRequestContext
}) => {
  const aId = await buildAndSend(page, MAYA, JORDAN, LINES)
  await setStock(request, 'VITD', 10)
  await setStock(request, 'MAG', 2)
  const amount = totalOf(IN_STOCK)

  await test.step('a declined partial payment leaves A with a back-order', async () => {
    await switchTo(page, JORDAN_USER)
    await openPatientOrder(page, aId)
    await declinePartialPayment(page, amount)
  })

  await test.step('the provider cancels A, reopens it and sends it again', async () => {
    await switchTo(page, MAYA)
    await openProviderOrder(page, aId)
    await page.getByRole('button', { name: 'Cancel order' }).click()
    const cancel = page.getByRole('alertdialog', { name: 'Cancel order' })
    await cancel.getByRole('button', { name: 'Cancel order' }).click()
    await expect(heading(page)).toContainText('Cancelled')

    await page.getByRole('button', { name: 'Reopen as draft' }).click()
    const reopen = page.getByRole('alertdialog', { name: 'Reopen as draft' })
    await reopen.getByRole('button', { name: 'Reopen as draft' }).click()
    await page.getByRole('button', { name: 'Send to patient' }).click()
    await page
      .getByRole('dialog', { name: 'Send with limited stock?' })
      .getByRole('button', { name: 'Send anyway' })
      .click()
    await expect(heading(page)).toContainText('Awaiting payment')
  })

  await test.step('the patient pays the in-stock part and gets a new back-order', async () => {
    await switchTo(page, JORDAN_USER)
    await openPatientOrder(page, aId)
    const bId = await payInStockItems(page, amount)
    expect(bId).not.toBe(aId)
  })
})

/** Pg access for setting up a gateway outage, which the HTTP API cannot cause. */
async function withDatabase<T>(run: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

test('an admin reconciles a payment stranded by a gateway outage', async ({
  page,
}) => {
  const orderId = await buildAndSend(page, MAYA, JORDAN, [
    { product: 'VITD', quantity: 1 },
  ])
  const amount = totalOf([{ product: 'VITD', quantity: 1 }])

  await test.step('the gateway fails mid-charge: payment is processing', async () => {
    await withDatabase((client) =>
      client.query(`
        create or replace function e2e_gateway_outage() returns trigger as $$
        begin raise exception 'simulated gateway outage'; end $$ language plpgsql;
        create trigger e2e_gateway_outage before insert on fake_gateway_charges
          for each row execute function e2e_gateway_outage();`),
    )
    await switchTo(page, JORDAN_USER)
    await openPatientOrder(page, orderId)
    await page.getByRole('button', { name: `Pay ${amount}` }).click()
    await expect(
      page.getByText('Your payment is being processed'),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Complete payment' }),
    ).toBeEnabled()
  })

  await test.step('the processor had in fact taken the charge', async () => {
    await withDatabase(async (client) => {
      await client.query(
        'drop trigger e2e_gateway_outage on fake_gateway_charges',
      )
      await client.query(
        `insert into fake_gateway_charges (idempotency_key, amount_cents, status, reference)
         select idempotency_key, amount_cents, 'succeeded', 'fake_ch_e2e_' || id
         from payment_attempts where order_id = $1 and status = 'pending'`,
        [orderId],
      )
    })
  })

  await test.step('the admin sees the attempt and reconciles it', async () => {
    await switchTo(page, ADMIN)
    await page.getByRole('link', { name: 'Accounts' }).click()
    const table = page.getByRole('table', {
      name: 'Payments needing attention',
    })
    const row = table.getByRole('row', {
      name: new RegExp(`Order #${orderId}`),
    })
    await expect(row).toContainText('Pending')
    await expect(row).toContainText(amount)
    await row
      .getByRole('button', { name: `Reconcile order ${orderId}` })
      .click()
    await page
      .getByRole('alertdialog', { name: 'Reconcile' })
      .getByRole('button', { name: 'Reconcile' })
      .click()
    await expect(
      page.getByText(`Order #${orderId} reconciled: payment recorded`),
    ).toBeVisible()
    await expect(row).toHaveCount(0)
  })

  await test.step('the patient now sees the order paid, once', async () => {
    await switchTo(page, JORDAN_USER)
    await openPatientOrder(page, orderId)
    await expect(heading(page)).toContainText('Paid')
    await expect(
      page.getByRole('region', { name: 'Receipt' }).getByRole('status'),
    ).toContainText(`Paid ${amount}`)
  })
})
