import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  USER_ID_HEADER,
  dashboardDtoSchema,
  providerOrderDetailDtoSchema,
} from '@supplement-orders/domain'
import type {
  DashboardDto,
  DashboardPaidOrderDto,
  OrderLineInput,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Tiles are all-time sums for the acting provider. Pending orders are absent
// from paidOrders and do not move the tiles. The order just paid is newest.
// Revision 2: the patient pays the subtotal, so GMV is that subtotal. Margin
// on a paid row is subtotal - wholesale cost - fee.

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const DASHBOARD_KEYS = [
  'gmvCents',
  'providerMarginCents',
  'platformFeeCents',
  'paidOrders',
]

const PAID_ORDER_KEYS = [
  'orderId',
  'patientId',
  'patientName',
  'paidAt',
  'totalCents',
  'cogsCents',
  'providerMarginCents',
  'platformFeeCents',
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
  'view',
  'split',
  'patientAddress',
  'lines',
  'payment',
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
  const record = asRecord(body)
  if (!Array.isArray(record.paidOrders)) {
    throw new Error('paidOrders must be an array')
  }
  record.paidOrders.forEach((order) => {
    expectExactKeys(order, PAID_ORDER_KEYS)
  })
  const dashboard = dashboardDtoSchema.parse(body)
  dashboard.paidOrders.forEach((order) => {
    expect(order.paidAt).toMatch(ISO_TIMESTAMP)
  })
  return dashboard
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

function sumBy(
  orders: readonly DashboardPaidOrderDto[],
  field: 'totalCents' | 'providerMarginCents' | 'platformFeeCents',
): number {
  return orders.reduce((sum, order) => sum + order[field], 0)
}

function expectTilesMatchRows(dashboard: DashboardDto): void {
  expect(dashboard.gmvCents).toBe(sumBy(dashboard.paidOrders, 'totalCents'))
  expect(dashboard.providerMarginCents).toBe(
    sumBy(dashboard.paidOrders, 'providerMarginCents'),
  )
  expect(dashboard.platformFeeCents).toBe(
    sumBy(dashboard.paidOrders, 'platformFeeCents'),
  )
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
    expectTilesMatchRows(before)
    const pending = await sendExample()
    const after = await getDashboard()

    expect(after).toEqual(before)
    expect(after.paidOrders.map((order) => order.orderId)).not.toContain(
      pending.id,
    )
  })

  it('adds a paid order to GMV, margin, and fees', async () => {
    const before = await getDashboard()
    const pending = await sendExample()
    const paid = await context()
      .request.post(`/api/orders/${pending.id}/pay`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
      .send({})
    expect(paid.status).toBe(200)

    const provider = await context()
      .request.get(`/api/orders/${pending.id}`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(provider.status).toBe(200)
    const detail = providerOrderDetailDtoSchema.parse(provider.body)
    const split = requireSplit(detail)
    expect(detail.paidAt).not.toBeNull()
    if (detail.paidAt === null) {
      throw new Error('paid order is missing paidAt')
    }
    expect(split.totalCents).toBe(split.subtotalCents)
    expect(split.providerMarginCents).toBe(
      split.subtotalCents - split.cogsCents - split.platformFeeCents,
    )

    const dashboard = await getDashboard()
    expectTilesMatchRows(dashboard)
    expect(dashboard.gmvCents).toBe(before.gmvCents + split.totalCents)
    expect(dashboard.providerMarginCents).toBe(
      before.providerMarginCents + split.providerMarginCents,
    )
    expect(dashboard.platformFeeCents).toBe(
      before.platformFeeCents + split.platformFeeCents,
    )
    expect(dashboard.paidOrders[0]?.orderId).toBe(detail.id)
    expect(dashboard.paidOrders[0]).toEqual({
      orderId: detail.id,
      patientId: detail.patientId,
      patientName: detail.patientName,
      paidAt: detail.paidAt,
      totalCents: split.totalCents,
      cogsCents: split.cogsCents,
      providerMarginCents: split.providerMarginCents,
      platformFeeCents: split.platformFeeCents,
    })
    expect(dashboard.paidOrders[0]?.paidAt).toMatch(ISO_TIMESTAMP)
  })
})
