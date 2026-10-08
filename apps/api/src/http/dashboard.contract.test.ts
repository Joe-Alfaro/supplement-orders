import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  USER_ID_HEADER,
  dashboardDtoSchema,
  providerOrderDetailDtoSchema,
} from '@supplement-orders/domain'
import type {
  DashboardDto,
  OrderLineInput,
  PayOrderRequest,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Tiles are all-time sums for the acting provider. A pending order does not
// move them. Revision 9 drops paidOrders; the paid list is
// GET /api/orders?status=paid. Revision 2: the patient pays the subtotal, so
// GMV is that subtotal. Margin is subtotal - wholesale cost - fee.

const DASHBOARD_KEYS = [
  'gmvCents',
  'providerMarginCents',
  'platformFeeCents',
  'range',
]

const PROVIDER_DETAIL_KEYS = [
  'id',
  'status',
  'patientId',
  'patientName',
  'providerId',
  'providerName',
  'createdAt',
  'sentAt',
  'paidAt',
  'cancelledAt',
  'revision',
  'splitFromOrderId',
  'backorderOrderId',
  'blockedByOrderId',
  'view',
  'split',
  'patientDateOfBirth',
  'patientAddress',
  'lines',
  'payment',
  'partialPaymentQuote',
  'paymentInProgress',
  'backorderStatus',
  'ledger',
]

interface ContextHolder {
  ctx?: TestContext
}

interface ExampleLine {
  productId: number
  quantity: number
  unitPriceCents: number
  unitCogsCents: number
}

const holder: ContextHolder = {}

function context(): TestContext {
  if (!holder.ctx) {
    throw new Error('test context was not created')
  }
  return holder.ctx
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value as Record<string, unknown>
}

function expectExactKeys(value: unknown, keys: readonly string[]): void {
  expect(Object.keys(asRecord(value)).sort()).toEqual([...keys].sort())
}

function expectDashboard(body: unknown): DashboardDto {
  expectExactKeys(body, DASHBOARD_KEYS)
  return dashboardDtoSchema.parse(body)
}

function ceilUnitFeeCents(priceCents: number): number {
  return Math.floor((priceCents * 75 + 9_999) / 10_000)
}

function minUnitPriceCents(unitCogsCents: number): number {
  function covers(priceCents: number): boolean {
    return priceCents - unitCogsCents >= ceilUnitFeeCents(priceCents)
  }
  function search(low: number, high: number): number {
    if (low === high) {
      return low
    }
    const mid = Math.floor((low + high) / 2)
    if (covers(mid)) {
      return search(low, mid)
    }
    return search(mid + 1, high)
  }
  if (unitCogsCents === 0) {
    return 0
  }
  return search(unitCogsCents, unitCogsCents * 2)
}

function exampleLine(products: TestContext['seed']['products']): ExampleLine {
  // $120.00 can be sent only when the minimum for that cost is at most $120.00.
  const product = products.find(
    (item) =>
      item.cogsCents >= 1 && minUnitPriceCents(item.cogsCents) <= 12_000,
  )
  expect(product).toBeDefined()
  if (!product) {
    throw new Error(
      'seed must include a product whose minimum price is at most 12000 cents',
    )
  }
  return {
    productId: product.id,
    quantity: 1,
    unitPriceCents: 12_000,
    unitCogsCents: product.cogsCents,
  }
}

async function getDashboard(): Promise<DashboardDto> {
  const response = await context()
    .request.get('/api/dashboard')
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectDashboard(response.body)
}

async function sendExample(): Promise<ProviderOrderDetailDto> {
  const line = exampleLine(context().seed.products)
  const created = await context()
    .request.post('/api/orders')
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
    .send({ patientId: context().seed.patientId })
  expect(created.status).toBe(201)
  expectExactKeys(created.body, PROVIDER_DETAIL_KEYS)
  const draft = providerOrderDetailDtoSchema.parse(created.body)
  const lines: OrderLineInput[] = [
    {
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    },
  ]
  const replaced = await context()
    .request.put(`/api/orders/${draft.id}/lines`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
    .send({ lines })
  expect(replaced.status).toBe(200)
  const sent = await context()
    .request.post(`/api/orders/${draft.id}/send`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(sent.status).toBe(200)
  expectExactKeys(sent.body, PROVIDER_DETAIL_KEYS)
  const detail = providerOrderDetailDtoSchema.parse(sent.body)
  const split = requireSplit(detail)
  expect(detail.status).toBe('pending_payment')
  expect(split.subtotalCents).toBe(12_000)
  expect(split.totalCents).toBe(12_000)
  expect(split.platformFeeCents).toBe(90)
  expect(split.cogsCents).toBe(line.unitCogsCents)
  expect(split.providerMarginCents).toBe(12_000 - line.unitCogsCents - 90)
  expect(
    split.cogsCents + split.providerMarginCents + split.platformFeeCents,
  ).toBe(split.totalCents)
  return detail
}

function requireSplit(
  detail: ProviderOrderDetailDto,
): NonNullable<ProviderOrderDetailDto['split']> {
  if (detail.split === null) {
    throw new Error('expected a server split')
  }
  return detail.split
}

beforeAll(async () => {
  holder.ctx = await createTestContext()
})

beforeEach(async () => {
  await context().reset()
})

afterAll(async () => {
  if (holder.ctx) {
    await holder.ctx.close()
  }
})

describe('GET /api/dashboard', () => {
  it('leaves the tiles unchanged while an order is pending payment', async () => {
    const before = await getDashboard()
    await sendExample()
    const after = await getDashboard()

    expect(after).toEqual(before)
  })

  it('adds a paid order to GMV, margin, and fees', async () => {
    const before = await getDashboard()
    const pending = await sendExample()
    const quote: PayOrderRequest = {
      expectedRevision: pending.revision,
      expectedTotalCents: requireSplit(pending).totalCents,
    }
    const paid = await context()
      .request.post(`/api/orders/${pending.id}/pay`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
      .send(quote)
    expect(paid.status).toBe(200)

    const provider = await context()
      .request.get(`/api/orders/${pending.id}`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(provider.status).toBe(200)
    const detail = providerOrderDetailDtoSchema.parse(provider.body)
    const split = requireSplit(detail)
    expect(detail.paidAt).not.toBeNull()
    expect(split.totalCents).toBe(split.subtotalCents)
    expect(split.providerMarginCents).toBe(
      split.subtotalCents - split.cogsCents - split.platformFeeCents,
    )

    const dashboard = await getDashboard()
    expect(dashboard.gmvCents).toBe(before.gmvCents + split.totalCents)
    expect(dashboard.providerMarginCents).toBe(
      before.providerMarginCents + split.providerMarginCents,
    )
    expect(dashboard.platformFeeCents).toBe(
      before.platformFeeCents + split.platformFeeCents,
    )
  })
})
