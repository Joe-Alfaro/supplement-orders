import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { addProduct, openPatient, signIn, signOut } from './flow'
import { formatCents } from './money'

// Revision 14 helpers (DOMAIN_CONTRACT 14.9). Orders are built and paid through
// the UI; exact stock levels are set through the admin API.

const API = 'http://localhost:3100/api'
const ADMIN_USER_ID = 7
const PROVIDER_USER_IDS = [1, 4]

/** Seed products (apps/api/src/db/seed.ts): sku fragment, id, minimum unit price. */
export const PRODUCTS = {
  VITD: { sku: 'VITD3', id: 1, minCents: 857 },
  MAG: { sku: 'MAG-GLY', id: 2, minCents: 1285 },
  OMEGA: { sku: 'OMEGA3', id: 3, minCents: 1653 },
  PROBIO: { sku: 'PROBIO', id: 4, minCents: 2216 },
  BCOMP: { sku: 'B-COMPLEX', id: 5, minCents: 998 },
} as const

export type ProductKey = keyof typeof PRODUCTS

export interface LineSpec {
  product: ProductKey
  quantity: number
}

/** The patient's total for lines at the minimum price the builder prefills. */
export function totalOf(lines: readonly LineSpec[]): string {
  return formatCents(
    lines.reduce(
      (sum, line) => sum + PRODUCTS[line.product].minCents * line.quantity,
      0,
    ),
  )
}

function headers(userId: number) {
  return { 'X-User-Id': String(userId), Accept: 'application/json' }
}

interface AdminProduct {
  id: number
  stockQuantity: number
}

async function currentStock(
  request: APIRequestContext,
  productId: number,
): Promise<number> {
  const response = await request.get(`${API}/admin/products?limit=100`, {
    headers: headers(ADMIN_USER_ID),
  })
  expect(response.ok()).toBe(true)
  const page = (await response.json()) as { items: AdminProduct[] }
  const found = page.items.find((item) => item.id === productId)
  expect(found).toBeDefined()
  return found?.stockQuantity ?? 0
}

/** Sets a product's stock to an exact value through the admin API. */
export async function setStock(
  request: APIRequestContext,
  product: ProductKey,
  stockQuantity: number,
): Promise<void> {
  const { id } = PRODUCTS[product]
  const expectedStockQuantity = await currentStock(request, id)
  const response = await request.put(`${API}/admin/products/${id}/stock`, {
    headers: headers(ADMIN_USER_ID),
    data: { stockQuantity, expectedStockQuantity },
  })
  expect(response.status()).toBe(200)
}

/** The admin "+N" button's endpoint. */
export async function addStock(
  request: APIRequestContext,
  product: ProductKey,
  by: number,
): Promise<void> {
  const response = await request.post(
    `${API}/admin/products/${PRODUCTS[product].id}/stock/increment`,
    { headers: headers(ADMIN_USER_ID), data: { by } },
  )
  expect(response.status()).toBe(200)
}

export async function snapshotStock(
  request: APIRequestContext,
): Promise<Record<ProductKey, number>> {
  const keys = Object.keys(PRODUCTS) as ProductKey[]
  const values = await Promise.all(
    keys.map((key) => currentStock(request, PRODUCTS[key].id)),
  )
  return Object.fromEntries(
    keys.map((key, index) => [key, values[index]]),
  ) as Record<ProductKey, number>
}

interface OrderRow {
  id: number
  status: string
}

/**
 * Leaves nothing unpaid behind: cancels (or deletes) every order a provider
 * still has open, then restores the stock the spec started with.
 */
export async function cleanUp(
  request: APIRequestContext,
  original: Record<ProductKey, number>,
): Promise<void> {
  await Promise.all(
    PROVIDER_USER_IDS.map(async (userId) => {
      const list = await request.get(`${API}/orders`, {
        headers: headers(userId),
      })
      const orders = (await list.json()) as OrderRow[]
      await Promise.all(
        orders.map((order) => {
          if (order.status === 'draft') {
            return request.delete(`${API}/orders/${order.id}`, {
              headers: headers(userId),
            })
          }
          if (
            order.status === 'pending_payment' ||
            order.status === 'awaiting_stock'
          ) {
            return request.post(`${API}/orders/${order.id}/cancel`, {
              headers: headers(userId),
            })
          }
          return Promise.resolve(null)
        }),
      )
    }),
  )
  const keys = Object.keys(PRODUCTS) as ProductKey[]
  await keys.reduce(async (previous, key) => {
    await previous
    await setStock(request, key, original[key])
  }, Promise.resolve())
}

function sequence<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  return items.reduce(async (previous, item) => {
    await previous
    await run(item)
  }, Promise.resolve() as Promise<void>)
}

/** Signs out first when someone is signed in, then signs in as `user`. */
export async function switchTo(page: Page, user: string): Promise<void> {
  if (await page.getByRole('button', { name: 'Sign out' }).isVisible()) {
    await signOut(page)
  }
  await signIn(page, user)
}

export interface SendOptions {
  /** Click "Send anyway" when the limited-stock confirmation appears. */
  acknowledge?: boolean
}

/** Builds the order in the order builder and sends it; returns the order id. */
export async function buildAndSend(
  page: Page,
  provider: string,
  patient: string,
  lines: readonly LineSpec[],
  options: SendOptions = {},
): Promise<number> {
  await switchTo(page, provider)
  await openPatient(page, patient)
  await page.getByRole('link', { name: 'New order' }).click()
  await sequence(lines, (line) =>
    addProduct(page, PRODUCTS[line.product].sku, { quantity: line.quantity }),
  )
  await page.getByRole('button', { name: 'Send to patient' }).click()
  if (options.acknowledge) {
    const dialog = page.getByRole('dialog', {
      name: 'Send with limited stock?',
    })
    await dialog.getByRole('button', { name: 'Send anyway' }).click()
  }
  await expect(page).toHaveURL(SENT_ORDER_URL)
  return orderIdFrom(page.url())
}

/** The provider order page. The builder's /patients/:id/orders/:id also ends this way. */
export const SENT_ORDER_URL = /^(?!.*\/patients\/).*\/orders\/\d+$/

export function orderIdFrom(url: string): number {
  const match = /\/(?:orders|my-orders)\/(\d+)$/.exec(url)
  expect(match).not.toBeNull()
  return Number(match?.[1])
}

export function heading(page: Page) {
  return page.getByRole('heading', { level: 1 })
}

export async function openPatientOrder(page: Page, id: number) {
  await page.goto(`/my-orders/${id}`)
  await expect(heading(page)).toContainText(`Order #${id}`)
}

export async function openProviderOrder(page: Page, id: number) {
  await page.goto(`/orders/${id}`)
  await expect(heading(page)).toContainText(`Order #${id}`)
}

/** Pays the in-stock part from the patient page; returns the back-order id. */
export async function payInStockItems(
  page: Page,
  amount: string,
): Promise<number> {
  await page
    .getByRole('button', { name: `Pay ${amount} for in-stock items` })
    .click()
  const receipt = page.getByRole('region', { name: 'Receipt' })
  await expect(receipt.getByRole('status')).toContainText(`Paid ${amount}`)
  const link = receipt.getByRole('link')
  await expect(link).toHaveCount(1)
  const href = await link.getAttribute('href')
  return orderIdFrom(href ?? '')
}
