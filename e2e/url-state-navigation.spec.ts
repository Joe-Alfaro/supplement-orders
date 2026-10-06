import { expect, test, type Page } from '@playwright/test'
import { AWAITING_ORDERS_LINK, signIn } from './flow'

// Read-only. The search boxes below are the ones that debounce a router.replace
// of ?q=. The add-product dialog also debounces, but it never writes the URL.
const PROVIDER = 'Dr. Maya Rivera (Provider)'

// Longer than the 250ms search debounce, so the replace runs while the click's
// navigation is still waiting on the lazy view.
const CHUNK_HOLD_MS = 1_000

interface Departure {
  name: string
  from: 'dashboard' | 'patients'
  searchLabel: string
  typed: string
  go: 'awaiting' | 'orders' | 'dashboard'
  chunk: string
  url: RegExp
  heading: string
}

const departures: readonly Departure[] = [
  {
    name: 'dashboard product search still opens orders awaiting payment',
    from: 'dashboard',
    searchLabel: 'Search products',
    typed: 'B-COMPLEX',
    go: 'awaiting',
    chunk: 'OrdersView.vue',
    url: /\/orders\?status=pending_payment$/,
    heading: 'Orders',
  },
  {
    name: 'dashboard product search still opens the Orders tab',
    from: 'dashboard',
    searchLabel: 'Search products',
    typed: 'B-COMPLEX',
    go: 'orders',
    chunk: 'OrdersView.vue',
    url: /\/orders$/,
    heading: 'Orders',
  },
  {
    name: 'patient search still opens the Dashboard',
    from: 'patients',
    searchLabel: 'Search by name or date of birth',
    typed: 'Alex',
    go: 'dashboard',
    chunk: 'DashboardView.vue',
    url: /\/dashboard$/,
    heading: 'Dashboard',
  },
  {
    name: 'patient search still opens the Orders tab',
    from: 'patients',
    searchLabel: 'Search by name or date of birth',
    typed: 'Alex',
    go: 'orders',
    chunk: 'OrdersView.vue',
    url: /\/orders$/,
    heading: 'Orders',
  },
]

/**
 * Holds the target view's module. The debounced replace must not cancel the
 * click, and it must not apply the page we left onto the address we arrive at.
 */
async function holdViewChunk(page: Page, fileName: string) {
  await page.route(
    (url) => url.pathname.includes(fileName),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_HOLD_MS))
      try {
        await route.continue()
      } catch {
        // The aborted navigation cancels the module request.
      }
    },
  )
}

function searchBox(page: Page, item: Departure) {
  if (item.from === 'dashboard') {
    return page
      .getByRole('region', { name: 'Inventory' })
      .getByLabel(item.searchLabel)
  }
  return page.getByLabel(item.searchLabel)
}

function destinationLink(page: Page, item: Departure) {
  if (item.go === 'awaiting') {
    return page.getByRole('link', { name: AWAITING_ORDERS_LINK, exact: true })
  }
  const label = item.go === 'orders' ? 'Orders' : 'Dashboard'
  return page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: label, exact: true })
}

async function openSource(page: Page, item: Departure) {
  await signIn(page, PROVIDER)
  if (item.from === 'patients') {
    await expect(
      page.getByRole('heading', { name: 'Patients', level: 1 }),
    ).toBeVisible()
    return
  }
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Dashboard', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeVisible()
}

departures.forEach((item) => {
  test(item.name, async ({ page }) => {
    await openSource(page, item)
    const box = searchBox(page, item)
    const link = destinationLink(page, item)
    await expect(box).toBeVisible()
    await expect(link).toBeVisible()
    await holdViewChunk(page, item.chunk)
    await box.fill(item.typed)
    await link.click()

    await expect(page).toHaveURL(item.url)
    await expect(
      page.getByRole('heading', { name: item.heading, level: 1, exact: true }),
    ).toBeVisible()
    // A late replace must not write the search we just left onto this address.
    await expect(page).toHaveURL(item.url)
    await expect(page).not.toHaveURL(/[?&]q=/)
  })
})
