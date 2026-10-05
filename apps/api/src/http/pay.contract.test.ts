import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  USER_ID_HEADER,
  apiErrorResponseSchema,
  patientOrderDetailDtoSchema,
  productDtoSchema,
  providerOrderDetailDtoSchema,
} from '@supplement-orders/domain'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  OrderLineInput,
  PatientOrderDetailDto,
  ProductDto,
  ProviderOrderDetailDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Pay returns the patient detail (200). The patient pays the subtotal, so
// totalCents equals that subtotal and the patient DTO has no fee or margin.
// A repeated pay is that same payment, not 409 ORDER_NOT_PAYABLE.
// Ledger rows stay in domain order and are immutable, so their ids do not change.

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

const PATIENT_DETAIL_KEYS = [
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
  'totalCents',
  'patientAddress',
  'lines',
  'payment',
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

const PATIENT_LINE_KEYS = [
  'productId',
  'productName',
  'sku',
  'quantity',
  'unitPriceCents',
  'lineTotalCents',
]

const PAYMENT_KEYS = ['id', 'amountCents', 'reference', 'createdAt']

const LEDGER_KEYS = ['id', 'type', 'amountCents', 'createdAt']

const PRODUCT_KEYS = ['id', 'sku', 'name', 'cogsCents', 'stockQuantity']

interface ContextHolder {
  ctx?: TestContext
}

interface ExampleLine {
  productId: number
  quantity: number
  unitPriceCents: number
  unitCogsCents: number
}

interface StockPair {
  id: number
  stockQuantity: number
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
  detail.ledger.forEach((entry) => {
    expectIsoTimestamp(entry.createdAt)
  })
  if (detail.payment) {
    expectIsoTimestamp(detail.payment.createdAt)
  }
  return detail
}

function expectPatientDetail(body: unknown): PatientOrderDetailDto {
  expectExactKeys(body, PATIENT_DETAIL_KEYS)
  const record = asRecord(body)
  if (!Array.isArray(record.lines)) {
    throw new Error('order lines must be an array')
  }
  record.lines.forEach((line) => {
    expectExactKeys(line, PATIENT_LINE_KEYS)
  })
  if (record.payment !== null) {
    expectExactKeys(record.payment, PAYMENT_KEYS)
  }
  const detail = patientOrderDetailDtoSchema.parse(body)
  expect(detail.view).toBe('patient')
  return detail
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

function stockPairs(products: readonly ProductDto[]): StockPair[] {
  return products
    .map((product) => ({
      id: product.id,
      stockQuantity: product.stockQuantity,
    }))
    .sort((left, right) => left.id - right.id)
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

async function sendOrder(orderId: number): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.post(`/api/orders/${orderId}/send`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
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

async function getPatientOrder(
  orderId: number,
): Promise<PatientOrderDetailDto> {
  const response = await context()
    .request.get(`/api/orders/${orderId}`)
    .set(USER_ID_HEADER, String(context().seed.patientUserId))
  expect(response.status).toBe(200)
  return expectPatientDetail(response.body)
}

async function placePayableOrder(): Promise<{
  detail: ProviderOrderDetailDto
  line: ExampleLine
}> {
  const line = exampleLine(context().seed.products)
  const draft = await createDraft()
  await putLines(draft.id, [
    {
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    },
  ])
  const detail = await sendOrder(draft.id)
  const split = requireSplit(detail)
  expect(detail.status).toBe('pending_payment')
  expect(split.subtotalCents).toBe(12_000)
  expect(split.platformFeeCents).toBe(90)
  expect(split.totalCents).toBe(12_000)
  expect(split.cogsCents).toBe(line.unitCogsCents)
  expect(split.providerMarginCents).toBe(12_000 - line.unitCogsCents - 90)
  return { detail, line }
}

function requireSplit(
  detail: ProviderOrderDetailDto,
): NonNullable<ProviderOrderDetailDto['split']> {
  if (detail.split === null) {
    throw new Error('expected a server split')
  }
  return detail.split
}

function pay(orderId: number, body: { simulateFailure?: boolean }) {
  return context()
    .request.post(`/api/orders/${orderId}/pay`)
    .set(USER_ID_HEADER, String(context().seed.patientUserId))
    .send(body)
}

function expectPaidLedger(detail: ProviderOrderDetailDto): void {
  const split = requireSplit(detail)
  expect(detail.status).toBe('paid')
  expect(detail.paidAt).not.toBeNull()
  if (detail.paidAt) {
    expectIsoTimestamp(detail.paidAt)
  }
  expect(detail.payment).not.toBeNull()
  if (!detail.payment) {
    throw new Error('paid order is missing a payment')
  }
  expect(split.totalCents).toBe(split.subtotalCents)
  expect(split.providerMarginCents).toBe(
    split.subtotalCents - split.cogsCents - split.platformFeeCents,
  )
  expect(
    split.cogsCents + split.providerMarginCents + split.platformFeeCents,
  ).toBe(split.totalCents)
  expect(detail.payment.reference.length).toBeGreaterThan(0)
  expect(detail.payment.amountCents).toBe(split.totalCents)
  expect(detail.ledger.map((entry) => entry.type)).toEqual([
    'cogs',
    'provider_margin',
    'platform_fee',
  ])
  expect(detail.ledger.map((entry) => entry.amountCents)).toEqual([
    split.cogsCents,
    split.providerMarginCents,
    split.platformFeeCents,
  ])
  const ledgerSum = detail.ledger.reduce(
    (sum, entry) => sum + entry.amountCents,
    0,
  )
  expect(ledgerSum).toBe(detail.payment.amountCents)
  expect(new Set(detail.ledger.map((entry) => entry.id)).size).toBe(3)
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

describe('POST /api/orders/:id/pay', () => {
  it('records three ledger entries and decrements stock by quantity', async () => {
    const placed = await placePayableOrder()
    const before = stockPairs(await listProducts())
    const response = await pay(placed.detail.id, {})
    expect(response.status).toBe(200)
    const patientOrder = expectPatientDetail(response.body)

    const split = requireSplit(placed.detail)
    expect(patientOrder.status).toBe('paid')
    expect(patientOrder.payment).not.toBeNull()
    expect(patientOrder.totalCents).toBe(split.totalCents)
    expect(patientOrder.totalCents).toBe(split.subtotalCents)
    expect(patientOrder.payment?.amountCents).toBe(patientOrder.totalCents)

    const providerOrder = await getProviderOrder(placed.detail.id)
    expectPaidLedger(providerOrder)
    expect(providerOrder.payment?.reference).toBe(
      patientOrder.payment?.reference,
    )
    expect(providerOrder.split).toEqual(split)

    const after = stockPairs(await listProducts())
    const beforeStock = before.find((item) => item.id === placed.line.productId)
    const afterStock = after.find((item) => item.id === placed.line.productId)
    expect(afterStock?.stockQuantity).toBe(
      (beforeStock?.stockQuantity ?? 0) - placed.line.quantity,
    )
    before
      .filter((item) => item.id !== placed.line.productId)
      .forEach((item) => {
        const match = after.find((candidate) => candidate.id === item.id)
        expect(match?.stockQuantity).toBe(item.stockQuantity)
      })
  })

  it('persists nothing when the gateway fails, then accepts a normal pay', async () => {
    const placed = await placePayableOrder()
    const before = stockPairs(await listProducts())
    const failed = await pay(placed.detail.id, { simulateFailure: true })

    expectError(failed, 402, 'PAYMENT_FAILED')
    const providerAfterFailure = await getProviderOrder(placed.detail.id)
    expect(providerAfterFailure.status).toBe('pending_payment')
    expect(providerAfterFailure.payment).toBeNull()
    expect(providerAfterFailure.ledger).toEqual([])
    expect(providerAfterFailure.paidAt).toBeNull()
    expect(providerAfterFailure.split).toEqual(placed.detail.split)
    const patientAfterFailure = await getPatientOrder(placed.detail.id)
    expect(patientAfterFailure.status).toBe('pending_payment')
    expect(patientAfterFailure.payment).toBeNull()
    expect(stockPairs(await listProducts())).toEqual(before)

    const paid = await pay(placed.detail.id, {})
    expect(paid.status).toBe(200)
    const providerPaid = await getProviderOrder(placed.detail.id)
    expectPaidLedger(providerPaid)
    const after = stockPairs(await listProducts())
    const beforeStock = before.find((item) => item.id === placed.line.productId)
    const afterStock = after.find((item) => item.id === placed.line.productId)
    expect(afterStock?.stockQuantity).toBe(
      (beforeStock?.stockQuantity ?? 0) - placed.line.quantity,
    )
  })

  it('returns the same payment when the patient pays twice', async () => {
    const placed = await placePayableOrder()
    const before = stockPairs(await listProducts())
    const first = await pay(placed.detail.id, {})
    expect(first.status).toBe(200)
    const firstPatient = expectPatientDetail(first.body)
    const firstProvider = await getProviderOrder(placed.detail.id)
    expectPaidLedger(firstProvider)
    const afterFirst = stockPairs(await listProducts())

    const second = await pay(placed.detail.id, {})
    expect(second.status).toBe(200)
    const secondPatient = expectPatientDetail(second.body)
    const secondProvider = await getProviderOrder(placed.detail.id)

    expect(secondPatient.payment?.reference).toBe(
      firstPatient.payment?.reference,
    )
    expect(secondPatient.payment?.id).toBe(firstPatient.payment?.id)
    expect(secondProvider.payment?.id).toBe(firstProvider.payment?.id)
    expect(secondProvider.ledger.map((entry) => entry.id).sort()).toEqual(
      firstProvider.ledger.map((entry) => entry.id).sort(),
    )
    expectPaidLedger(secondProvider)
    expect(stockPairs(await listProducts())).toEqual(afterFirst)
    const beforeStock = before.find((item) => item.id === placed.line.productId)
    const afterStock = afterFirst.find(
      (item) => item.id === placed.line.productId,
    )
    expect(afterStock?.stockQuantity).toBe(
      (beforeStock?.stockQuantity ?? 0) - placed.line.quantity,
    )
  })
})
