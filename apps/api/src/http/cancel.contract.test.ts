import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  USER_ID_HEADER,
  apiErrorResponseSchema,
  awaitingPaymentPageDtoSchema,
  dashboardDtoSchema,
  patientOrderDetailDtoSchema,
  patientOrderSummaryDtoSchema,
  patientPageDtoSchema,
  productDtoSchema,
  providerOrderDetailDtoSchema,
  userDtoSchema,
} from '@supplement-orders/domain'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  AwaitingPaymentOrderDto,
  AwaitingPaymentPageDto,
  DashboardDto,
  OrderLineInput,
  PayOrderRequest,
  PatientOrderDetailDto,
  PatientOrderSummaryDto,
  PatientPageDto,
  ProductDto,
  ProviderOrderDetailDto,
  UserDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// POST /api/orders/:id/cancel returns the provider detail for a
// pending_payment order: status becomes cancelled and cancelledAt is set.
// A draft, a paid order, or a second cancel is 409 ORDER_NOT_CANCELLABLE.
// Drafts are deleted, not cancelled. Cancel writes no ledger rows and does
// not change stock. The patient cannot cancel (403). Another provider cannot
// cancel someone else's order (403), the same rule as reading it. A missing
// or unknown X-User-Id is 401.
// Paying a cancelled order is 409 ORDER_NOT_PAYABLE and persists nothing.
// A patient's list includes a cancelled order that was sent, and still hides
// drafts.
// GET /api/orders?status= is provider-only. draft, pending_payment, paid,
// cancelled, and all each return Page<ProviderOrderListItemDto>.
// pending_payment is oldest sentAt first, then id. A value outside that set,
// or a bad offset or limit, is 400 naming the field.
// Cancelled orders do not move dashboard GMV, margin, or fees.

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const USER_KEYS = ['id', 'name', 'role', 'providerId', 'patientId']

const PAGE_KEYS = ['items', 'total', 'offset', 'limit']

const PROVIDER_SUMMARY_KEYS = [
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
  'view',
  'split',
]

const PATIENT_SUMMARY_KEYS = [
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
  'view',
  'totalCents',
]

const PROVIDER_DETAIL_KEYS = [
  ...PROVIDER_SUMMARY_KEYS,
  'patientDateOfBirth',
  'patientAddress',
  'lines',
  'payment',
  'ledger',
]

const PATIENT_DETAIL_KEYS = [
  ...PATIENT_SUMMARY_KEYS,
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
  'markupBps',
  'minUnitPriceCents',
  'stockQuantity',
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

const PATIENT_KEYS = [
  'id',
  'userId',
  'providerId',
  'name',
  'dateOfBirth',
  'address',
  'orderCount',
  'latestOrderStatus',
]

const AWAITING_KEYS = [
  'id',
  'patientId',
  'patientName',
  'patientDateOfBirth',
  'status',
  'totalCents',
  'createdAt',
  'sentAt',
  'paidAt',
  'cancelledAt',
]

const DASHBOARD_KEYS = [
  'gmvCents',
  'providerMarginCents',
  'platformFeeCents',
  'range',
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

interface StockPair {
  id: number
  stockQuantity: number
}

interface HttpResult {
  status: number
  body: unknown
}

interface AwaitingParams {
  offset?: string
  limit?: string
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

function expectOptionalTimestamp(value: string | null): void {
  if (value !== null) {
    expectIsoTimestamp(value)
  }
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
  expectOptionalTimestamp(detail.sentAt)
  expectOptionalTimestamp(detail.paidAt)
  expectOptionalTimestamp(detail.cancelledAt)
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
  expectIsoTimestamp(detail.createdAt)
  expectOptionalTimestamp(detail.sentAt)
  expectOptionalTimestamp(detail.paidAt)
  expectOptionalTimestamp(detail.cancelledAt)
  if (detail.payment) {
    expectIsoTimestamp(detail.payment.createdAt)
  }
  return detail
}

function expectPatientSummaries(body: unknown): PatientOrderSummaryDto[] {
  if (!Array.isArray(body)) {
    throw new Error('order list must be an array')
  }
  body.forEach((order) => {
    expectExactKeys(order, PATIENT_SUMMARY_KEYS)
  })
  const summaries = z.array(patientOrderSummaryDtoSchema).parse(body)
  summaries.forEach((order) => {
    expect(order.view).toBe('patient')
    expectIsoTimestamp(order.createdAt)
    expectOptionalTimestamp(order.sentAt)
    expectOptionalTimestamp(order.paidAt)
    expectOptionalTimestamp(order.cancelledAt)
  })
  return summaries
}

function expectStatusPage(body: unknown): AwaitingPaymentPageDto {
  expectExactKeys(body, PAGE_KEYS)
  const record = asRecord(body)
  if (!Array.isArray(record.items)) {
    throw new Error('items must be an array')
  }
  record.items.forEach((item) => {
    expectExactKeys(item, AWAITING_KEYS)
  })
  const page = awaitingPaymentPageDtoSchema.parse(body)
  page.items.forEach((item) => {
    expectIsoTimestamp(item.createdAt)
    expectOptionalTimestamp(item.sentAt)
    expectOptionalTimestamp(item.paidAt)
    expectOptionalTimestamp(item.cancelledAt)
  })
  return page
}

function expectAwaitingPage(body: unknown): AwaitingPaymentPageDto {
  const page = expectStatusPage(body)
  page.items.forEach((item) => {
    expect(item.status).toBe('pending_payment')
    expect(item.paidAt).toBeNull()
    expect(item.cancelledAt).toBeNull()
    expectIsoTimestamp(requireSentAt(item))
  })
  return page
}

function onlyListItem(page: AwaitingPaymentPageDto): AwaitingPaymentOrderDto {
  const item = page.items[0]
  if (item === undefined || page.items.length !== 1) {
    throw new Error('expected one order list row')
  }
  return item
}

function expectPatientPage(body: unknown): PatientPageDto {
  expectExactKeys(body, PAGE_KEYS)
  const record = asRecord(body)
  if (!Array.isArray(record.items)) {
    throw new Error('items must be an array')
  }
  record.items.forEach((item) => {
    expectExactKeys(item, PATIENT_KEYS)
  })
  return patientPageDtoSchema.parse(body)
}

function expectDashboard(body: unknown): DashboardDto {
  expectExactKeys(body, DASHBOARD_KEYS)
  return dashboardDtoSchema.parse(body)
}

function requireSentAt(item: AwaitingPaymentOrderDto): string {
  if (item.sentAt === null) {
    throw new Error('awaiting order is missing sentAt')
  }
  return item.sentAt
}

function expectOldestFirst(items: readonly AwaitingPaymentOrderDto[]): void {
  items.slice(1).forEach((item, index) => {
    const previous = items[index]
    if (previous === undefined) {
      throw new Error('missing the previous awaiting order')
    }
    const bySent = requireSentAt(previous).localeCompare(requireSentAt(item))
    expect(bySent).toBeLessThanOrEqual(0)
    if (bySent === 0) {
      expect(previous.id).toBeLessThan(item.id)
    }
  })
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

function requireSplit(
  detail: ProviderOrderDetailDto,
): NonNullable<ProviderOrderDetailDto['split']> {
  if (detail.split === null) {
    throw new Error('expected a server split')
  }
  return detail.split
}

function requireCancelledAt(detail: ProviderOrderDetailDto): string {
  if (detail.cancelledAt === null) {
    throw new Error('cancelled order is missing cancelledAt')
  }
  expectIsoTimestamp(detail.cancelledAt)
  return detail.cancelledAt
}

function awaitingRow(detail: ProviderOrderDetailDto): AwaitingPaymentOrderDto {
  const split = requireSplit(detail)
  if (detail.sentAt === null) {
    throw new Error('awaiting order is missing sentAt')
  }
  return {
    id: detail.id,
    patientId: detail.patientId,
    patientName: detail.patientName,
    patientDateOfBirth: detail.patientDateOfBirth,
    status: 'pending_payment',
    totalCents: split.totalCents,
    createdAt: detail.createdAt,
    sentAt: detail.sentAt,
    paidAt: null,
    cancelledAt: null,
  }
}

function definedQuery(
  params: Record<string, string | undefined>,
): Record<string, string> {
  const entries = Object.entries(params).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, value]],
  )
  return Object.fromEntries(entries)
}

function stockPairs(products: readonly ProductDto[]): StockPair[] {
  return products
    .map((product) => ({
      id: product.id,
      stockQuantity: product.stockQuantity,
    }))
    .sort((left, right) => left.id - right.id)
}

function expectPaidLedger(detail: ProviderOrderDetailDto): void {
  const split = requireSplit(detail)
  expect(detail.status).toBe('paid')
  expect(detail.cancelledAt).toBeNull()
  expect(detail.paidAt).not.toBeNull()
  expect(detail.payment).not.toBeNull()
  if (!detail.payment) {
    throw new Error('paid order is missing a payment')
  }
  expect(detail.ledger).toHaveLength(3)
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
  expect(new Set(detail.ledger.map((entry) => entry.id)).size).toBe(3)
  expect(detail.payment.amountCents).toBe(split.totalCents)
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

async function getDashboard(): Promise<DashboardDto> {
  const response = await context()
    .request.get('/api/dashboard')
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectDashboard(response.body)
}

async function createDraftFor(
  userId: number,
  patientId: number,
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.post('/api/orders')
    .set(USER_ID_HEADER, String(userId))
    .send({ patientId })
  expect(response.status).toBe(201)
  return expectProviderDetail(response.body)
}

function createDraft(): Promise<ProviderOrderDetailDto> {
  return createDraftFor(context().seed.providerUserId, context().seed.patientId)
}

async function putLinesFor(
  userId: number,
  orderId: number,
  lines: readonly OrderLineInput[],
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.put(`/api/orders/${orderId}/lines`)
    .set(USER_ID_HEADER, String(userId))
    .send({ lines })
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

async function sendOrderFor(
  userId: number,
  orderId: number,
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.post(`/api/orders/${orderId}/send`)
    .set(USER_ID_HEADER, String(userId))
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

async function getProviderOrder(
  orderId: number,
  userId: number = context().seed.providerUserId,
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.get(`/api/orders/${orderId}`)
    .set(USER_ID_HEADER, String(userId))
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

function cancelAs(orderId: number, userId?: number) {
  const request = context().request.post(`/api/orders/${orderId}/cancel`)
  if (userId === undefined) {
    return request
  }
  return request.set(USER_ID_HEADER, String(userId))
}

function cancel(orderId: number) {
  return cancelAs(orderId, context().seed.providerUserId)
}

async function cancelOrder(orderId: number): Promise<ProviderOrderDetailDto> {
  const response = await cancel(orderId)
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

function pay(order: ProviderOrderDetailDto) {
  const body: PayOrderRequest = {
    expectedRevision: order.revision,
    expectedTotalCents: requireSplit(order).totalCents,
  }
  return context()
    .request.post(`/api/orders/${order.id}/pay`)
    .set(USER_ID_HEADER, String(context().seed.patientUserId))
    .send(body)
}

async function placePayableOrder(
  userId: number = context().seed.providerUserId,
  patientId: number = context().seed.patientId,
): Promise<{ detail: ProviderOrderDetailDto; line: ExampleLine }> {
  const line = exampleLine(context().seed.products)
  const draft = await createDraftFor(userId, patientId)
  await putLinesFor(userId, draft.id, [
    {
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    },
  ])
  const detail = await sendOrderFor(userId, draft.id)
  const split = requireSplit(detail)
  expect(detail.status).toBe('pending_payment')
  expect(detail.cancelledAt).toBeNull()
  expect(detail.paidAt).toBeNull()
  expect(detail.sentAt).not.toBeNull()
  expect(detail.payment).toBeNull()
  expect(detail.ledger).toEqual([])
  expect(split.subtotalCents).toBe(12_000)
  expect(split.totalCents).toBe(12_000)
  expect(split.platformFeeCents).toBe(90)
  expect(split.cogsCents).toBe(line.unitCogsCents)
  expect(split.providerMarginCents).toBe(12_000 - line.unitCogsCents - 90)
  return { detail, line }
}

async function otherProviderPatientId(): Promise<number> {
  const response = await context()
    .request.get('/api/patients')
    .query({ limit: 1 })
    .set(USER_ID_HEADER, String(context().seed.otherProviderUserId))
  expect(response.status).toBe(200)
  const page = expectPatientPage(response.body)
  const patient = page.items[0]
  if (patient === undefined) {
    throw new Error('the other provider has no patient')
  }
  expect(patient.id).not.toBe(context().seed.patientId)
  return patient.id
}

async function getOrders(
  params: Record<string, string>,
  userId: number,
): Promise<HttpResult> {
  const response = await context()
    .request.get('/api/orders')
    .query(params)
    .set(USER_ID_HEADER, String(userId))
  return { status: response.status, body: response.body }
}

async function getAwaiting(
  params: AwaitingParams,
  userId: number = context().seed.providerUserId,
): Promise<AwaitingPaymentPageDto> {
  const response = await getOrders(
    definedQuery({
      status: 'pending_payment',
      offset: params.offset,
      limit: params.limit,
    }),
    userId,
  )
  expect(response.status).toBe(200)
  return expectAwaitingPage(response.body)
}

function expectCancelled(
  detail: ProviderOrderDetailDto,
  previous: ProviderOrderDetailDto,
): string {
  const cancelledAt = requireCancelledAt(detail)
  expect(detail.id).toBe(previous.id)
  expect(detail.status).toBe('cancelled')
  expect(detail.paidAt).toBeNull()
  expect(detail.payment).toBeNull()
  expect(detail.ledger).toEqual([])
  expect(detail.createdAt).toBe(previous.createdAt)
  expect(detail.sentAt).toBe(previous.sentAt)
  expect(detail.patientId).toBe(previous.patientId)
  expect(detail.lines).toEqual(previous.lines)
  return cancelledAt
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

describe('POST /api/orders/:id/cancel', () => {
  it('refuses to cancel a draft and leaves it a draft', async () => {
    const draft = await createDraft()
    expect(draft.status).toBe('draft')
    expect(draft.cancelledAt).toBeNull()
    expect(draft.sentAt).toBeNull()
    expect(draft.paidAt).toBeNull()
    expect(draft.split).toBeNull()
    expect(draft.lines).toEqual([])

    const response = await cancel(draft.id)
    expectError(
      { status: response.status, body: response.body },
      409,
      'ORDER_NOT_CANCELLABLE',
    )

    const current = await getProviderOrder(draft.id)
    expect(current).toEqual(draft)
  })

  it('cancels a pending payment order without a ledger row or a stock change', async () => {
    const before = stockPairs(await listProducts())
    const placed = await placePayableOrder()
    const response = await cancel(placed.detail.id)
    expect(response.status).toBe(200)
    const cancelled = expectProviderDetail(response.body)
    const cancelledAt = expectCancelled(cancelled, placed.detail)
    expect(cancelled.split).toEqual(placed.detail.split)
    expect(cancelled.sentAt).not.toBeNull()

    const again = await cancel(placed.detail.id)
    expectError(
      { status: again.status, body: again.body },
      409,
      'ORDER_NOT_CANCELLABLE',
    )

    const current = await getProviderOrder(placed.detail.id)
    expect(current.status).toBe('cancelled')
    expect(current.cancelledAt).toBe(cancelledAt)
    expect(current.ledger).toEqual([])
    expect(current.payment).toBeNull()
    expect(current.split).toEqual(placed.detail.split)
    expect(stockPairs(await listProducts())).toEqual(before)
  })

  it('refuses to cancel a paid order and leaves its three ledger entries', async () => {
    const placed = await placePayableOrder()
    const beforePay = stockPairs(await listProducts())
    const paidResponse = await pay(placed.detail)
    expect(paidResponse.status).toBe(200)
    const patientPaid = expectPatientDetail(paidResponse.body)
    expect(patientPaid.status).toBe('paid')
    expect(patientPaid.cancelledAt).toBeNull()
    expect(patientPaid.payment).not.toBeNull()

    const paid = await getProviderOrder(placed.detail.id)
    expectPaidLedger(paid)
    const afterPay = stockPairs(await listProducts())
    const beforeStock = beforePay.find(
      (item) => item.id === placed.line.productId,
    )
    const paidStock = afterPay.find((item) => item.id === placed.line.productId)
    expect(paidStock?.stockQuantity).toBe(
      (beforeStock?.stockQuantity ?? 0) - placed.line.quantity,
    )

    const refused = await cancel(placed.detail.id)
    expectError(
      { status: refused.status, body: refused.body },
      409,
      'ORDER_NOT_CANCELLABLE',
    )

    const current = await getProviderOrder(placed.detail.id)
    expect(current.status).toBe('paid')
    expect(current.cancelledAt).toBeNull()
    expect(current.paidAt).toBe(paid.paidAt)
    expect(current.sentAt).toBe(paid.sentAt)
    expect(current.payment).toEqual(paid.payment)
    expect(current.split).toEqual(paid.split)
    expect(current.ledger).toHaveLength(3)
    expect(current.ledger).toEqual(paid.ledger)
    expectPaidLedger(current)
    expect(stockPairs(await listProducts())).toEqual(afterPay)

    const patientCurrent = await context()
      .request.get(`/api/orders/${placed.detail.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(patientCurrent.status).toBe(200)
    const patientOrder = expectPatientDetail(patientCurrent.body)
    expect(patientOrder.status).toBe('paid')
    expect(patientOrder.cancelledAt).toBeNull()
    expect(patientOrder.payment).toEqual(patientPaid.payment)
  })

  it('forbids a patient and another provider, and rejects an unknown user', async () => {
    const placed = await placePayableOrder()
    const patient = await cancelAs(
      placed.detail.id,
      context().seed.patientUserId,
    )
    expectError(
      { status: patient.status, body: patient.body },
      403,
      'FORBIDDEN',
    )

    const otherProvider = await cancelAs(
      placed.detail.id,
      context().seed.otherProviderUserId,
    )
    expectError(
      { status: otherProvider.status, body: otherProvider.body },
      403,
      'FORBIDDEN',
    )

    const missing = await cancelAs(placed.detail.id)
    expectError(
      { status: missing.status, body: missing.body },
      401,
      'UNAUTHENTICATED',
    )

    const users = await listUsers()
    const unknownId =
      users.reduce((highest, user) => Math.max(highest, user.id), 0) + 1
    const unknown = await cancelAs(placed.detail.id, unknownId)
    expectError(
      { status: unknown.status, body: unknown.body },
      401,
      'UNAUTHENTICATED',
    )

    const current = await getProviderOrder(placed.detail.id)
    expect(current.status).toBe('pending_payment')
    expect(current.cancelledAt).toBeNull()
    expect(current.payment).toBeNull()
    expect(current.ledger).toEqual([])
    expect(current.sentAt).toBe(placed.detail.sentAt)
  })
})

describe('POST /api/orders/:id/pay', () => {
  it('refuses a cancelled order and leaves stock, payment, and the ledger unchanged', async () => {
    const before = stockPairs(await listProducts())
    const placed = await placePayableOrder()
    const cancelled = await cancelOrder(placed.detail.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.payment).toBeNull()
    expect(cancelled.ledger).toEqual([])

    const refused = await pay(placed.detail)
    expectError(
      { status: refused.status, body: refused.body },
      409,
      'ORDER_NOT_PAYABLE',
    )

    const current = await getProviderOrder(placed.detail.id)
    expect(current.status).toBe('cancelled')
    expect(current.cancelledAt).toBe(cancelled.cancelledAt)
    expect(current.payment).toBeNull()
    expect(current.ledger).toEqual([])
    expect(current.paidAt).toBeNull()
    expect(stockPairs(await listProducts())).toEqual(before)
  })
})

describe('GET /api/orders', () => {
  it('includes a cancelled sent order and still hides drafts', async () => {
    const openDraft = await createDraft()
    expect(openDraft.status).toBe('draft')
    expect(openDraft.sentAt).toBeNull()

    const pending = await placePayableOrder()
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    const split = requireSplit(cancelled)
    expect(cancelled.sentAt).not.toBeNull()

    const list = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(list.status).toBe(200)
    const summaries = expectPatientSummaries(list.body)
    const ids = summaries.map((order) => order.id)
    expect(summaries.every((order) => order.status !== 'draft')).toBe(true)
    expect(ids).not.toContain(openDraft.id)

    const pendingRow = summaries.find((order) => order.id === pending.detail.id)
    expect(pendingRow?.status).toBe('pending_payment')
    expect(pendingRow?.cancelledAt).toBeNull()
    expect(pendingRow?.totalCents).toBe(12_000)

    const cancelledRow = summaries.find((order) => order.id === cancelled.id)
    expect(cancelledRow).toEqual({
      id: cancelled.id,
      status: 'cancelled',
      patientId: cancelled.patientId,
      patientName: cancelled.patientName,
      providerId: cancelled.providerId,
      providerName: cancelled.providerName,
      createdAt: cancelled.createdAt,
      sentAt: cancelled.sentAt,
      paidAt: null,
      cancelledAt: cancelled.cancelledAt,
      revision: cancelled.revision,
      view: 'patient',
      totalCents: split.totalCents,
    })

    const hidden = await context()
      .request.get(`/api/orders/${openDraft.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expectError({ status: hidden.status, body: hidden.body }, 404, 'NOT_FOUND')

    const visible = await context()
      .request.get(`/api/orders/${cancelled.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(visible.status).toBe(200)
    const patientOrder = expectPatientDetail(visible.body)
    expect(patientOrder.status).toBe('cancelled')
    expect(patientOrder.cancelledAt).toBe(cancelled.cancelledAt)
    expect(patientOrder.paidAt).toBeNull()
    expect(patientOrder.payment).toBeNull()
    expect(patientOrder.totalCents).toBe(split.totalCents)
    expect(patientOrder.sentAt).toBe(cancelled.sentAt)
  })
})

describe('GET /api/orders?status=pending_payment', () => {
  it('returns the provider page oldest first and omits every other order', async () => {
    const first = await placePayableOrder()
    const second = await placePayableOrder()
    const third = await placePayableOrder()
    const draft = await createDraft()
    const paid = await placePayableOrder()
    const paidResponse = await pay(paid.detail)
    expect(paidResponse.status).toBe(200)
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    const foreign = await placePayableOrder(
      context().seed.otherProviderUserId,
      await otherProviderPatientId(),
    )
    const expected = [first.detail, second.detail, third.detail].map(
      awaitingRow,
    )
    const hiddenIds = [
      draft.id,
      paid.detail.id,
      cancelled.id,
      foreign.detail.id,
    ]

    const all = await getAwaiting({ limit: '100' })
    expect(all).toEqual({
      items: expected,
      total: 3,
      offset: 0,
      limit: 100,
    })
    expectOldestFirst(all.items)
    expect(all.items.map((item) => item.totalCents)).toEqual([
      12_000, 12_000, 12_000,
    ])
    hiddenIds.forEach((id) => {
      expect(all.items.map((item) => item.id)).not.toContain(id)
    })

    const page0 = await getAwaiting({ offset: '0', limit: '1' })
    const page1 = await getAwaiting({ offset: '1', limit: '1' })
    const page2 = await getAwaiting({ offset: '2', limit: '1' })
    expect(page0).toEqual({
      items: expected.slice(0, 1),
      total: 3,
      offset: 0,
      limit: 1,
    })
    expect(page1).toEqual({
      items: expected.slice(1, 2),
      total: 3,
      offset: 1,
      limit: 1,
    })
    expect(page2).toEqual({
      items: expected.slice(2, 3),
      total: 3,
      offset: 2,
      limit: 1,
    })

    const pastEnd = await getAwaiting({ offset: '3', limit: '1' })
    expect(pastEnd).toEqual({ items: [], total: 3, offset: 3, limit: 1 })
    const far = await getAwaiting({ offset: '100', limit: '25' })
    expect(far).toEqual({ items: [], total: 3, offset: 100, limit: 25 })

    const defaults = await getAwaiting({})
    expect(defaults).toEqual({
      items: expected,
      total: 3,
      offset: 0,
      limit: 25,
    })

    const theirs = await getAwaiting(
      { limit: '100' },
      context().seed.otherProviderUserId,
    )
    expect(theirs).toEqual({
      items: [awaitingRow(foreign.detail)],
      total: 1,
      offset: 0,
      limit: 100,
    })
    expected.forEach((item) => {
      expect(theirs.items.map((row) => row.id)).not.toContain(item.id)
    })
  })

  it('rejects a patient', async () => {
    const response = await getOrders(
      { status: 'pending_payment' },
      context().seed.patientUserId,
    )
    expectError(response, 403, 'FORBIDDEN')
  })

  it.each<[Record<string, string>, string]>([
    [{ status: 'shipped' }, 'status'],
    [{ status: 'PAID' }, 'status'],
    [{ status: '' }, 'status'],
    [{ status: 'pending_payment', offset: '-1' }, 'offset'],
    [{ status: 'pending_payment', offset: '1.5' }, 'offset'],
    [{ status: 'pending_payment', limit: '0' }, 'limit'],
    [{ status: 'pending_payment', limit: '101' }, 'limit'],
    [{ status: 'pending_payment', limit: '1.5' }, 'limit'],
  ])('rejects %j on %s', async (query, field) => {
    const response = await getOrders(query, context().seed.providerUserId)
    expectError(response, 400, 'VALIDATION_ERROR', field)
  })

  it('accepts draft, paid, cancelled, and all', async () => {
    const draft = await createDraft()
    const pending = await placePayableOrder()
    const paidPlaced = await placePayableOrder()
    const paidResponse = await pay(paidPlaced.detail)
    expect(paidResponse.status).toBe(200)
    const paid = await getProviderOrder(paidPlaced.detail.id)
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    const paidSplit = requireSplit(paid)
    const cancelledSplit = requireSplit(cancelled)
    if (
      paid.paidAt === null ||
      paid.sentAt === null ||
      cancelled.sentAt === null
    ) {
      throw new Error('sent orders are missing their timestamps')
    }

    async function statusPage(status: string): Promise<AwaitingPaymentPageDto> {
      const response = await getOrders(
        { status, limit: '100' },
        context().seed.providerUserId,
      )
      expect(response.status).toBe(200)
      const page = expectStatusPage(response.body)
      expect(page.offset).toBe(0)
      expect(page.limit).toBe(100)
      return page
    }

    const drafts = await statusPage('draft')
    expect(drafts.total).toBe(1)
    expect(onlyListItem(drafts)).toEqual({
      id: draft.id,
      patientId: draft.patientId,
      patientName: draft.patientName,
      patientDateOfBirth: draft.patientDateOfBirth,
      status: 'draft',
      totalCents: null,
      createdAt: draft.createdAt,
      sentAt: null,
      paidAt: null,
      cancelledAt: null,
    })

    const paidPage = await statusPage('paid')
    expect(paidPage.total).toBe(1)
    expect(onlyListItem(paidPage)).toEqual({
      id: paid.id,
      patientId: paid.patientId,
      patientName: paid.patientName,
      patientDateOfBirth: paid.patientDateOfBirth,
      status: 'paid',
      totalCents: paidSplit.totalCents,
      createdAt: paid.createdAt,
      sentAt: paid.sentAt,
      paidAt: paid.paidAt,
      cancelledAt: null,
    })

    const cancelledPage = await statusPage('cancelled')
    expect(cancelledPage.total).toBe(1)
    expect(onlyListItem(cancelledPage)).toEqual({
      id: cancelled.id,
      patientId: cancelled.patientId,
      patientName: cancelled.patientName,
      patientDateOfBirth: cancelled.patientDateOfBirth,
      status: 'cancelled',
      totalCents: cancelledSplit.totalCents,
      createdAt: cancelled.createdAt,
      sentAt: cancelled.sentAt,
      paidAt: null,
      cancelledAt: cancelled.cancelledAt,
    })

    const all = await statusPage('all')
    expect(all.total).toBe(4)
    expect(
      all.items.map((item) => item.id).sort((left, right) => left - right),
    ).toEqual(
      [draft.id, pending.detail.id, paid.id, cancelled.id].sort(
        (left, right) => left - right,
      ),
    )
    expect(all.items.map((item) => item.status).sort()).toEqual([
      'cancelled',
      'draft',
      'paid',
      'pending_payment',
    ])
  })
})

describe('GET /api/dashboard', () => {
  it('leaves GMV, margin, and fees unchanged when orders are cancelled', async () => {
    const placed = await placePayableOrder()
    const paidResponse = await pay(placed.detail)
    expect(paidResponse.status).toBe(200)
    const paid = await getProviderOrder(placed.detail.id)
    const split = requireSplit(paid)
    expect(paid.paidAt).not.toBeNull()

    const before = await getDashboard()
    expect(before.gmvCents).toBe(split.totalCents)
    expect(before.providerMarginCents).toBe(split.providerMarginCents)
    expect(before.platformFeeCents).toBe(split.platformFeeCents)

    const draft = await createDraft()
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    expect(draft.status).toBe('draft')
    expect(cancelled.status).toBe('cancelled')

    const after = await getDashboard()
    expect(after).toEqual(before)
  })
})
