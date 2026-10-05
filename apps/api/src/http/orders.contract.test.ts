import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  USER_ID_HEADER,
  apiErrorResponseSchema,
  productDtoSchema,
  providerOrderDetailDtoSchema,
  userDtoSchema,
} from '@supplement-orders/domain'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  OrderLineInput,
  ProductDto,
  ProviderOrderDetailDto,
  UserDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Black-box HTTP contract. The harness module is owned by the API worker.
// Money expectations use the documented integer formulas, not a domain import.
// Revision 2: the patient pays the subtotal. The fee comes out of the markup.
// Only POST /api/orders is specified as 201. Successful PUT, send, and pay
// are 200. A below-minimum price is saved; send rejects it.

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

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

const SPLIT_KEYS = [
  'subtotalCents',
  'platformFeeCents',
  'totalCents',
  'cogsCents',
  'providerMarginCents',
]

const PROVIDER_LINE_KEYS = [
  'productId',
  'productName',
  'sku',
  'quantity',
  'unitPriceCents',
  'lineTotalCents',
  'unitCogsCents',
  'marginBps',
  'minUnitPriceCents',
]

const PAYMENT_KEYS = ['id', 'amountCents', 'reference', 'createdAt']

const LEDGER_KEYS = ['id', 'type', 'amountCents', 'createdAt']

const PRODUCT_KEYS = ['id', 'sku', 'name', 'cogsCents', 'stockQuantity']

const USER_KEYS = ['id', 'name', 'role', 'providerId', 'patientId']

interface ContextHolder {
  ctx?: TestContext
}

interface ExampleLine {
  productId: number
  quantity: number
  unitPriceCents: number
  unitCogsCents: number
}

interface ExpectedSplit {
  subtotalCents: number
  platformFeeCents: number
  totalCents: number
  cogsCents: number
  providerMarginCents: number
}

interface HttpResult {
  status: number
  body: unknown
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

function expectIsoTimestamp(value: string): void {
  expect(value).toMatch(ISO_TIMESTAMP)
}

function expectError(
  response: HttpResult,
  status: number,
  code: ApiErrorCode,
  field?: string,
): ApiErrorResponse {
  expect(response.status).toBe(status)
  const parsed = apiErrorResponseSchema.parse(response.body)
  expect(parsed.error.code).toBe(code)
  expect(parsed.error.message.length).toBeGreaterThan(0)
  expectExactKeys(response.body, ['error'])
  if (field === undefined) {
    expectExactKeys(asRecord(response.body).error, ['code', 'message'])
    expect(parsed.error.field).toBeUndefined()
  } else {
    expectExactKeys(asRecord(response.body).error, ['code', 'message', 'field'])
    expect(parsed.error.field).toBe(field)
  }
  return parsed
}

function expectProviderDetail(body: unknown): ProviderOrderDetailDto {
  expectExactKeys(body, PROVIDER_DETAIL_KEYS)
  const record = asRecord(body)
  if (record.split === null) {
    expect(record.split).toBeNull()
  } else {
    expectExactKeys(record.split, SPLIT_KEYS)
  }
  if (!Array.isArray(record.lines) || !Array.isArray(record.ledger)) {
    throw new Error('order lines and ledger must be arrays')
  }
  record.lines.forEach((line) => {
    expectExactKeys(line, PROVIDER_LINE_KEYS)
  })
  record.ledger.forEach((entry) => {
    expectExactKeys(entry, LEDGER_KEYS)
  })
  if (record.payment !== null) {
    expectExactKeys(record.payment, PAYMENT_KEYS)
  }
  const detail = providerOrderDetailDtoSchema.parse(body)
  expect(detail.view).toBe('provider')
  expectIsoTimestamp(detail.createdAt)
  if (detail.sentAt) {
    expectIsoTimestamp(detail.sentAt)
  }
  if (detail.paidAt) {
    expectIsoTimestamp(detail.paidAt)
  }
  detail.ledger.forEach((entry) => {
    expectIsoTimestamp(entry.createdAt)
  })
  if (detail.payment) {
    expectIsoTimestamp(detail.payment.createdAt)
  }
  return detail
}

function platformFeeCents(subtotalCents: number): number {
  return Math.floor((subtotalCents * 75 + 5_000) / 10_000)
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

function marginBpsFromPrice(
  unitCogsCents: number,
  unitPriceCents: number,
): number {
  if (unitPriceCents === 0) {
    return 0
  }
  const numerator = (unitPriceCents - unitCogsCents) * 10_000
  return Math.floor((numerator * 2 + unitPriceCents) / (unitPriceCents * 2))
}

function expectedSplit(line: ExampleLine): ExpectedSplit {
  const subtotalCents = line.quantity * line.unitPriceCents
  const cogsCents = line.quantity * line.unitCogsCents
  const feeCents = platformFeeCents(subtotalCents)
  return {
    subtotalCents,
    platformFeeCents: feeCents,
    totalCents: subtotalCents,
    cogsCents,
    providerMarginCents: subtotalCents - cogsCents - feeCents,
  }
}

function exampleLine(products: TestContext['seed']['products']): ExampleLine {
  // $120.00 can be sent only when the minimum for that cost is at most $120.00.
  // A positive cost is what makes a one-cent-under-cost price expressible.
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

async function listUsers(): Promise<UserDto[]> {
  const response = await context().request.get('/api/users')
  expect(response.status).toBe(200)
  if (!Array.isArray(response.body)) {
    throw new Error('user list must be an array')
  }
  response.body.forEach((user) => {
    expectExactKeys(user, USER_KEYS)
  })
  return z.array(userDtoSchema).parse(response.body)
}

async function listProducts(): Promise<ProductDto[]> {
  const response = await context()
    .request.get('/api/products')
    .query({ limit: 100 })
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  const items = asRecord(response.body).items
  if (!Array.isArray(items)) {
    throw new Error('product list must be an array')
  }
  items.forEach((product) => {
    expectExactKeys(product, PRODUCT_KEYS)
  })
  return z.array(productDtoSchema).parse(items)
}

async function createDraft(): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.post('/api/orders')
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
    .send({ patientId: context().seed.patientId })
  expect(response.status).toBe(201)
  return expectProviderDetail(response.body)
}

async function putLines(
  orderId: number,
  lines: readonly OrderLineInput[],
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.put(`/api/orders/${orderId}/lines`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
    .send({ lines })
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

function sendOrder(orderId: number) {
  return context()
    .request.post(`/api/orders/${orderId}/send`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
}

async function getProviderOrder(
  orderId: number,
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.get(`/api/orders/${orderId}`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

function requireSplit(detail: ProviderOrderDetailDto): ExpectedSplit {
  if (detail.split === null) {
    throw new Error('expected a server split')
  }
  return detail.split
}

function stockOf(products: readonly ProductDto[], productId: number): number {
  const product = products.find((item) => item.id === productId)
  expect(product).toBeDefined()
  if (!product) {
    throw new Error(`product ${productId} is missing from the catalog`)
  }
  return product.stockQuantity
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

describe('order draft and send', () => {
  it('creates an empty draft for the acting provider patient', async () => {
    const users = await listUsers()
    const provider = users.find(
      (user) => user.id === context().seed.providerUserId,
    )
    expect(provider?.role).toBe('provider')
    if (!provider || provider.providerId === null) {
      throw new Error('seeded provider user is missing a provider id')
    }

    const draft = await createDraft()

    expect(draft.status).toBe('draft')
    expect(draft.patientId).toBe(context().seed.patientId)
    expect(draft.providerId).toBe(provider.providerId)
    expect(draft.lines).toEqual([])
    expect(draft.ledger).toEqual([])
    expect(draft.payment).toBeNull()
    expect(draft.sentAt).toBeNull()
    expect(draft.paidAt).toBeNull()
    expect(draft.split).toBeNull()
  })

  it('sends the $120.00 order and returns the server split', async () => {
    const catalog = await listProducts()
    context().seed.products.forEach((seeded) => {
      const listed = catalog.find((product) => product.id === seeded.id)
      expect(listed?.cogsCents).toBe(seeded.cogsCents)
      expect(listed?.stockQuantity).toBe(seeded.stockQuantity)
      expect(seeded.stockQuantity).toBeGreaterThanOrEqual(10)
    })
    expect(context().seed.products.length).toBeGreaterThanOrEqual(3)

    const line = exampleLine(context().seed.products)
    const expected = expectedSplit(line)
    const stockBefore = stockOf(catalog, line.productId)
    const draft = await createDraft()
    const edited = await putLines(draft.id, [
      {
        productId: line.productId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
      },
    ])

    expect(edited.status).toBe('draft')
    expect(edited.split).toEqual(expected)
    expect(edited.lines).toHaveLength(1)
    const savedLine = edited.lines[0]
    expect(savedLine?.unitCogsCents).toBe(line.unitCogsCents)
    expect(savedLine?.unitPriceCents).toBe(12_000)
    expect(savedLine?.lineTotalCents).toBe(12_000)
    expect(savedLine?.minUnitPriceCents).toBe(
      minUnitPriceCents(line.unitCogsCents),
    )
    expect(savedLine?.marginBps).toBe(
      marginBpsFromPrice(line.unitCogsCents, 12_000),
    )
    expect(savedLine?.unitPriceCents).toBeGreaterThanOrEqual(
      savedLine?.minUnitPriceCents ?? 0,
    )

    const sentResponse = await sendOrder(draft.id)
    expect(sentResponse.status).toBe(200)
    const sent = expectProviderDetail(sentResponse.body)
    const sentSplit = requireSplit(sent)

    expect(sent.status).toBe('pending_payment')
    expect(sentSplit).toEqual(expected)
    expect(sentSplit.subtotalCents).toBe(12_000)
    expect(sentSplit.platformFeeCents).toBe(90)
    expect(sentSplit.totalCents).toBe(12_000)
    expect(sentSplit.providerMarginCents).toBe(12_000 - line.unitCogsCents - 90)
    expect(
      sentSplit.cogsCents +
        sentSplit.providerMarginCents +
        sentSplit.platformFeeCents,
    ).toBe(sentSplit.totalCents)
    if (line.unitCogsCents === 7_000) {
      expect(sentSplit.cogsCents).toBe(7_000)
      expect(sentSplit.providerMarginCents).toBe(4_910)
    }
    expect(sent.payment).toBeNull()
    expect(sent.ledger).toEqual([])
    expect(sent.sentAt).not.toBeNull()
    expect(sent.paidAt).toBeNull()
    expect(stockOf(await listProducts(), line.productId)).toBe(stockBefore)
  })

  it('saves a below-minimum price and rejects it on send', async () => {
    // Save does not enforce the minimum. N is the offending line. A price
    // one cent under cost is below the minimum and still stored.
    const products = context().seed.products
    const priced = exampleLine(products)
    const belowCost = products.find((item) => item.id !== priced.productId)
    expect(belowCost).toBeDefined()
    if (!belowCost) {
      throw new Error('seed must include a second product')
    }
    const lowPrice = belowCost.cogsCents - 1
    const draft = await createDraft()
    const saved = await putLines(draft.id, [
      {
        productId: priced.productId,
        quantity: 1,
        unitPriceCents: priced.unitPriceCents,
      },
      {
        productId: belowCost.id,
        quantity: 1,
        unitPriceCents: lowPrice,
      },
    ])

    expect(saved.split).toBeNull()
    expect(saved.lines[1]?.unitPriceCents).toBe(lowPrice)
    expect(saved.lines[1]?.unitCogsCents).toBe(belowCost.cogsCents)
    expect(saved.lines[1]?.minUnitPriceCents).toBe(
      minUnitPriceCents(belowCost.cogsCents),
    )
    expect(saved.lines[1]?.marginBps).toBe(
      marginBpsFromPrice(belowCost.cogsCents, lowPrice),
    )
    expect(saved.lines[1]?.marginBps ?? 0).toBeLessThan(0)

    const sent = await sendOrder(draft.id)
    expectError(sent, 422, 'PRICE_BELOW_MINIMUM', 'lines.1.unitPriceCents')

    const current = await getProviderOrder(draft.id)
    expect(current.status).toBe('draft')
    expect(current.sentAt).toBeNull()
    expect(current.split).toBeNull()
    expect(current.lines.map((line) => line.unitPriceCents)).toEqual([
      priced.unitPriceCents,
      lowPrice,
    ])
  })

  it('saves incomplete lines in order and names the gap on send', async () => {
    // A missing product is reported before a missing price on the same line.
    // Quantity defaults to 1 when the client omits it.
    const products = context().seed.products
    const missingPrice = exampleLine(products)
    const complete = products.find((item) => item.id !== missingPrice.productId)
    expect(complete).toBeDefined()
    if (!complete) {
      throw new Error('seed must include a second product')
    }
    const catalog = await listProducts()
    const named = catalog.find((item) => item.id === missingPrice.productId)
    expect(named).toBeDefined()
    if (!named) {
      throw new Error('priced product is missing from the catalog')
    }

    const draft = await createDraft()
    const saved = await putLines(draft.id, [
      { productId: missingPrice.productId, unitPriceCents: null },
      {},
      {
        productId: complete.id,
        quantity: 2,
        unitPriceCents: 12_000,
      },
    ])
    const reloaded = await getProviderOrder(draft.id)

    expect(saved.split).toBeNull()
    expect(reloaded.lines).toEqual(saved.lines)
    expect(saved.lines.map((line) => line.productId)).toEqual([
      missingPrice.productId,
      null,
      complete.id,
    ])
    expect(saved.lines[0]).toMatchObject({
      productName: named.name,
      sku: named.sku,
      quantity: 1,
      unitPriceCents: null,
      lineTotalCents: null,
      unitCogsCents: missingPrice.unitCogsCents,
      marginBps: null,
      minUnitPriceCents: minUnitPriceCents(missingPrice.unitCogsCents),
    })
    expect(saved.lines[1]).toMatchObject({
      productName: null,
      sku: null,
      quantity: 1,
      unitPriceCents: null,
      lineTotalCents: null,
      unitCogsCents: null,
      marginBps: null,
      minUnitPriceCents: null,
    })
    expect(saved.lines[2]).toMatchObject({
      quantity: 2,
      unitPriceCents: 12_000,
      lineTotalCents: 24_000,
      unitCogsCents: complete.cogsCents,
      marginBps: marginBpsFromPrice(complete.cogsCents, 12_000),
      minUnitPriceCents: minUnitPriceCents(complete.cogsCents),
    })

    const missingProduct = await createDraft()
    await putLines(missingProduct.id, [
      {
        productId: complete.id,
        quantity: 1,
        unitPriceCents: 12_000,
      },
      { unitPriceCents: 1_000 },
    ])
    const noProduct = await sendOrder(missingProduct.id)
    expectError(noProduct, 422, 'INCOMPLETE_LINE', 'lines.1.productId')

    const missingOnlyPrice = await createDraft()
    await putLines(missingOnlyPrice.id, [{ productId: missingPrice.productId }])
    const noPrice = await sendOrder(missingOnlyPrice.id)
    expectError(noPrice, 422, 'INCOMPLETE_LINE', 'lines.0.unitPriceCents')

    const missingBoth = await createDraft()
    await putLines(missingBoth.id, [{}])
    const neither = await sendOrder(missingBoth.id)
    expectError(neither, 422, 'INCOMPLETE_LINE', 'lines.0.productId')
  })

  it('does not expose a stock update endpoint', async () => {
    const catalog = await listProducts()
    const product = catalog[0]
    expect(product).toBeDefined()
    if (!product) {
      throw new Error('catalog is empty')
    }
    const response = await context()
      .request.patch(`/api/products/${product.id}/stock`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
      .send({ stockQuantity: product.stockQuantity + 1 })

    expectError(response, 404, 'NOT_FOUND')
    expect(stockOf(await listProducts(), product.id)).toBe(
      product.stockQuantity,
    )
  })

  it('rejects sending a draft with no lines', async () => {
    // EMPTY_ORDER has no line index in the domain, so the API field is omitted.
    const draft = await createDraft()
    const sent = await sendOrder(draft.id)

    expectError(sent, 422, 'EMPTY_ORDER')
    const current = await getProviderOrder(draft.id)
    expect(current.status).toBe('draft')
    expect(current.lines).toEqual([])
  })
})
