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
// Money expectations use the documented half-up formula, not a domain import.
// Only POST /api/orders is specified as 201. PUT, send, and pay are 200.

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
  'unitMarginCents',
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
  expectExactKeys(record.split, SPLIT_KEYS)
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

function expectedSplit(line: ExampleLine): ExpectedSplit {
  const subtotalCents = line.quantity * line.unitPriceCents
  const cogsCents = line.quantity * line.unitCogsCents
  const feeCents = platformFeeCents(subtotalCents)
  return {
    subtotalCents,
    platformFeeCents: feeCents,
    totalCents: subtotalCents + feeCents,
    cogsCents,
    providerMarginCents: subtotalCents - cogsCents,
  }
}

function exampleLine(products: TestContext['seed']['products']): ExampleLine {
  // The harness does not bound COGS. The published $120.00 example can be sent
  // only when some seeded product costs at most $120.00, and price < COGS needs
  // a positive cost. One product in that range satisfies both.
  const product = products.find(
    (item) => item.cogsCents >= 1 && item.cogsCents <= 12_000,
  )
  expect(product).toBeDefined()
  if (!product) {
    throw new Error(
      'seed must include a product with COGS between 1 and 12000 cents',
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
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  if (!Array.isArray(response.body)) {
    throw new Error('product list must be an array')
  }
  response.body.forEach((product) => {
    expectExactKeys(product, PRODUCT_KEYS)
  })
  return z.array(productDtoSchema).parse(response.body)
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
    expect(draft.split).toEqual({
      subtotalCents: 0,
      platformFeeCents: 0,
      totalCents: 0,
      cogsCents: 0,
      providerMarginCents: 0,
    })
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
    expect(edited.lines[0]?.unitCogsCents).toBe(line.unitCogsCents)
    expect(edited.lines[0]?.unitPriceCents).toBe(12_000)
    expect(edited.lines[0]?.lineTotalCents).toBe(12_000)
    expect(edited.lines[0]?.unitMarginCents).toBe(12_000 - line.unitCogsCents)

    const sentResponse = await sendOrder(draft.id)
    expect(sentResponse.status).toBe(200)
    const sent = expectProviderDetail(sentResponse.body)

    expect(sent.status).toBe('pending_payment')
    expect(sent.split).toEqual(expected)
    expect(sent.split.subtotalCents).toBe(12_000)
    expect(sent.split.platformFeeCents).toBe(90)
    expect(sent.split.totalCents).toBe(12_090)
    expect(sent.split.cogsCents + sent.split.providerMarginCents).toBe(12_000)
    expect(
      sent.split.cogsCents +
        sent.split.providerMarginCents +
        sent.split.platformFeeCents,
    ).toBe(sent.split.totalCents)
    if (line.unitCogsCents === 7_000) {
      expect(sent.split.cogsCents).toBe(7_000)
      expect(sent.split.providerMarginCents).toBe(5_000)
    }
    expect(sent.payment).toBeNull()
    expect(sent.ledger).toEqual([])
    expect(sent.sentAt).not.toBeNull()
    expect(sent.paidAt).toBeNull()
    expect(stockOf(await listProducts(), line.productId)).toBe(stockBefore)
  })

  it('rejects a price below COGS on send', async () => {
    // Field path matches the replace-lines body. Index 0 is the only line.
    // PUT may store the line. unitMarginCents is documented as nonnegative, so
    // that response is not parsed as a provider detail. Send must reject it.
    const line = exampleLine(context().seed.products)
    const draft = await createDraft()
    const saved = await context()
      .request.put(`/api/orders/${draft.id}/lines`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
      .send({
        lines: [
          {
            productId: line.productId,
            quantity: 1,
            unitPriceCents: line.unitCogsCents - 1,
          },
        ],
      })
    expect(saved.status).toBe(200)

    const sent = await sendOrder(draft.id)
    expectError(sent, 422, 'PRICE_BELOW_COGS', 'lines.0.unitPriceCents')

    const current = await context()
      .request.get(`/api/orders/${draft.id}`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(current.status).toBe(200)
    expect(asRecord(current.body).status).toBe('draft')
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
