import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  USER_ID_HEADER,
  apiErrorResponseSchema,
  patientOrderSummaryDtoSchema,
  patientPageDtoSchema,
  productDtoSchema,
  providerOrderDetailDtoSchema,
  providerOrderListPageDtoSchema,
  providerOrderSummaryDtoSchema,
  userDtoSchema,
} from '@supplement-orders/domain'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  OrderLineInput,
  PatientDto,
  PatientOrderSummaryDto,
  PatientPageDto,
  ProductDto,
  ProviderOrderDetailDto,
  ProviderOrderListItemDto,
  ProviderOrderListPageDto,
  ProviderOrderSummaryDto,
  UserDto,
} from '@supplement-orders/domain'
import { orders } from '../db/schema'
import { createInternalTestContext } from '../testing/harness'
import type { InternalTestContext } from '../testing/harness'

// Revision 8 HTTP contract. The domain types landed first; this file stays red
// until DELETE, reopen, the provider status page, and latestStatus are implemented.
//
// DELETE /api/orders/:id is 204 with no body for the provider's own draft. GET
// then is 404, and the order is absent from GET /api/orders?status=draft.
// Deleting a pending, paid, or cancelled order is 409 ORDER_NOT_DRAFT. A patient
// is 403. Another provider is 403, the same rule as reading someone else's
// order, not 404. A missing or unknown X-User-Id is 401.
//
// POST /api/orders/:id/reopen turns a cancelled order into a draft and returns
// the provider detail. sentAt, cancelledAt, and paidAt are null, and the stored
// subtotal, platform fee, and total are cleared. Lines stay. A complete draft
// is priced live, so split is that live split rather than null. The patient no
// longer sees it (list, and 404 on GET) until it is sent again. Sending again
// works and the patient can pay. Reopen of a draft, pending_payment, or paid
// order is 409 ORDER_NOT_REOPENABLE. Cancel plus reopen does not change stock.
//
// GET /api/orders?status= is provider-only and returns a page of
// ProviderOrderListItemDto. status is a comma-separated set of draft,
// pending_payment, paid, and cancelled, or exactly all (revision 8b).
// Duplicates are ignored. An empty value, an unknown member, an empty item,
// or all mixed with a status is 400 on status. Exactly pending_payment (one
// status after de-duplicating) is oldest sentAt first, then id. Every other
// selection, including all and any multi-status set, is most recent activity
// first (latest of paidAt, cancelledAt, sentAt, createdAt), then id
// descending. totalCents and sentAt are null for drafts and for orders
// cancelled before sending. A bad offset or limit is 400 naming that field.
// Without status, the provider array and the patient array are unchanged. A
// patient who passes status is 403.
//
// GET /api/patients?latestStatus= keeps patients whose most recently created
// order (created_at, not updated_at) has that status. none means no orders. It
// combines with q. A bad value is 400 naming latestStatus.

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const SEP = '2026-09-01T00:00:00.000Z'
const AUG = '2026-08-01T00:00:00.000Z'
const JUL = '2026-07-01T00:00:00.000Z'
const JUN = '2026-06-01T00:00:00.000Z'
const MAY = '2026-05-01T00:00:00.000Z'
const APR = '2026-04-01T00:00:00.000Z'
const MAR = '2026-03-01T00:00:00.000Z'
const FEB = '2026-02-01T00:00:00.000Z'
const JAN = '2026-01-01T00:00:00.000Z'
const JAN_SENT = '2026-01-02T00:00:00.000Z'

const PAGE_KEYS = ['items', 'total', 'offset', 'limit']

const USER_KEYS = ['id', 'name', 'role', 'providerId', 'patientId']

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

const ORDER_LIST_ITEM_KEYS = [
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

interface ContextHolder {
  ctx?: InternalTestContext
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

interface OrderClock {
  createdAt?: string
  sentAt?: string
  paidAt?: string
  cancelledAt?: string
}

interface StoredTotals {
  subtotalCents: number | null
  platformFeeCents: number | null
  totalCents: number | null
}

interface PlacedOrder {
  detail: ProviderOrderDetailDto
  line: ExampleLine
}

const holder: ContextHolder = {}

function context(): InternalTestContext {
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

function expectOptionalTimestamp(value: string | null): void {
  if (value !== null) {
    expectIsoTimestamp(value)
  }
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

function expectNoContent(response: { status: number; text: string }): void {
  expect(response.status).toBe(204)
  expect(response.text).toBe('')
}

function expectProviderDetail(body: unknown): ProviderOrderDetailDto {
  expectExactKeys(body, PROVIDER_DETAIL_KEYS)
  const record = asRecord(body)
  if (record.split !== null) {
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
  return detail
}

function expectProviderSummaries(body: unknown): ProviderOrderSummaryDto[] {
  if (!Array.isArray(body)) {
    throw new Error('provider order list without status must stay an array')
  }
  body.forEach((order) => {
    expectExactKeys(order, PROVIDER_SUMMARY_KEYS)
  })
  const summaries = z.array(providerOrderSummaryDtoSchema).parse(body)
  summaries.forEach((order) => {
    expect(order.view).toBe('provider')
    expectIsoTimestamp(order.createdAt)
  })
  return summaries
}

function expectPatientSummaries(body: unknown): PatientOrderSummaryDto[] {
  if (!Array.isArray(body)) {
    throw new Error('patient order list must stay an array')
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

function expectOrderListPage(body: unknown): ProviderOrderListPageDto {
  expectExactKeys(body, PAGE_KEYS)
  const record = asRecord(body)
  if (!Array.isArray(record.items)) {
    throw new Error('items must be an array')
  }
  record.items.forEach((item) => {
    expectExactKeys(item, ORDER_LIST_ITEM_KEYS)
  })
  const page = providerOrderListPageDtoSchema.parse(body)
  page.items.forEach((item) => {
    expectIsoTimestamp(item.createdAt)
    expectOptionalTimestamp(item.sentAt)
    expectOptionalTimestamp(item.paidAt)
    expectOptionalTimestamp(item.cancelledAt)
  })
  return page
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

function exampleLine(
  products: InternalTestContext['seed']['products'],
): ExampleLine {
  const product = products.find(
    (item) =>
      item.cogsCents >= 1 && minUnitPriceCents(item.cogsCents) <= 12_000,
  )
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

function stockPairs(products: readonly ProductDto[]): StockPair[] {
  return products
    .map((product) => ({
      id: product.id,
      stockQuantity: product.stockQuantity,
    }))
    .sort((left, right) => left.id - right.id)
}

function stockOf(products: readonly ProductDto[], productId: number): number {
  const product = products.find((item) => item.id === productId)
  if (product === undefined) {
    throw new Error('product missing from the catalog')
  }
  return product.stockQuantity
}

function idsOf(page: ProviderOrderListPageDto): number[] {
  return page.items.map((item) => item.id)
}

function firstPatient(page: PatientPageDto): PatientDto {
  const patient = page.items[0]
  if (patient === undefined) {
    throw new Error('expected a patient')
  }
  return patient
}

function requireListItem(
  page: ProviderOrderListPageDto,
  orderId: number,
): ProviderOrderListItemDto {
  const item = page.items.find((row) => row.id === orderId)
  if (item === undefined) {
    throw new Error(`order ${orderId} missing from the page`)
  }
  return item
}

function letterIn(name: string, include: (char: string) => boolean): string {
  const letter = name
    .toLowerCase()
    .split('')
    .find((char) => /[a-z]/.test(char) && include(char))
  if (letter === undefined) {
    throw new Error('patient names did not yield a search letter')
  }
  return letter
}

function sharedLetter(left: string, right: string): string {
  return letterIn(left, (char) => right.toLowerCase().includes(char))
}

function uniqueLetter(name: string, other: string): string {
  return letterIn(name, (char) => !other.toLowerCase().includes(char))
}

function expectPatientNames(
  page: ProviderOrderListPageDto,
  directory: readonly PatientDto[],
): void {
  page.items.forEach((item) => {
    const patient = directory.find((row) => row.id === item.patientId)
    if (patient === undefined) {
      throw new Error(
        "list item patient is not one of this provider's patients",
      )
    }
    expect(item.patientName).toBe(patient.name)
    expect(item.patientDateOfBirth).toBe(patient.dateOfBirth)
  })
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

async function patientIdFor(userId: number): Promise<number> {
  const user = (await listUsers()).find((item) => item.id === userId)
  if (user === undefined || user.patientId === null) {
    throw new Error('expected a patient user')
  }
  return user.patientId
}

async function getPatientsRaw(
  params: Record<string, string>,
  userId: number,
): Promise<HttpResult> {
  const response = await context()
    .request.get('/api/patients')
    .query(params)
    .set(USER_ID_HEADER, String(userId))
  return { status: response.status, body: response.body }
}

async function getPatients(
  params: Record<string, string> = {},
  userId: number = context().seed.providerUserId,
): Promise<PatientPageDto> {
  const response = await getPatientsRaw(params, userId)
  expect(response.status).toBe(200)
  return expectPatientPage(response.body)
}

async function otherProviderPatientId(): Promise<number> {
  const page = await getPatients(
    { limit: '1' },
    context().seed.otherProviderUserId,
  )
  const patient = page.items[0]
  if (patient === undefined) {
    throw new Error('the other provider has no patient')
  }
  expect(patient.id).not.toBe(context().seed.patientId)
  return patient.id
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
): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.get(`/api/orders/${orderId}`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

async function cancelOrder(orderId: number): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.post(`/api/orders/${orderId}/cancel`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectProviderDetail(response.body)
}

function pay(orderId: number, userId: number = context().seed.patientUserId) {
  return context()
    .request.post(`/api/orders/${orderId}/pay`)
    .set(USER_ID_HEADER, String(userId))
    .send({})
}

async function placePayableOrder(
  userId: number = context().seed.providerUserId,
  patientId: number = context().seed.patientId,
): Promise<PlacedOrder> {
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
  expect(detail.sentAt).not.toBeNull()
  expect(split.subtotalCents).toBe(12_000)
  expect(split.totalCents).toBe(12_000)
  expect(split.platformFeeCents).toBe(90)
  return { detail, line }
}

async function savePricedDraft(
  userId: number = context().seed.providerUserId,
  patientId: number = context().seed.patientId,
): Promise<ProviderOrderDetailDto> {
  const line = exampleLine(context().seed.products)
  const draft = await createDraftFor(userId, patientId)
  const saved = await putLinesFor(userId, draft.id, [
    {
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    },
  ])
  expect(saved.status).toBe('draft')
  expect(saved.sentAt).toBeNull()
  expect(saved.lines).toHaveLength(1)
  return saved
}

async function placePaid(
  userId: number = context().seed.providerUserId,
  patientId: number = context().seed.patientId,
  patientUserId: number = context().seed.patientUserId,
): Promise<PlacedOrder> {
  const placed = await placePayableOrder(userId, patientId)
  const response = await pay(placed.detail.id, patientUserId)
  expect(response.status).toBe(200)
  const detail = await getProviderOrder(placed.detail.id)
  expect(detail.status).toBe('paid')
  expect(detail.paidAt).not.toBeNull()
  return { detail, line: placed.line }
}

async function orderWithStatus(
  status: 'draft' | 'pending_payment' | 'paid',
): Promise<ProviderOrderDetailDto> {
  if (status === 'draft') {
    return savePricedDraft()
  }
  if (status === 'pending_payment') {
    return (await placePayableOrder()).detail
  }
  return (await placePaid()).detail
}

function deleteOrder(orderId: number, userId?: number) {
  const request = context().request.delete(`/api/orders/${orderId}`)
  if (userId === undefined) {
    return request
  }
  return request.set(USER_ID_HEADER, String(userId))
}

function reopenOrder(orderId: number, userId?: number) {
  const request = context().request.post(`/api/orders/${orderId}/reopen`)
  if (userId === undefined) {
    return request
  }
  return request.set(USER_ID_HEADER, String(userId))
}

async function stampOrder(orderId: number, clock: OrderClock): Promise<void> {
  await context()
    .db.update(orders)
    .set({
      ...(clock.createdAt === undefined
        ? {}
        : { createdAt: new Date(clock.createdAt) }),
      ...(clock.sentAt === undefined ? {} : { sentAt: new Date(clock.sentAt) }),
      ...(clock.paidAt === undefined ? {} : { paidAt: new Date(clock.paidAt) }),
      ...(clock.cancelledAt === undefined
        ? {}
        : { cancelledAt: new Date(clock.cancelledAt) }),
    })
    .where(eq(orders.id, orderId))
}

async function storedTotals(orderId: number): Promise<StoredTotals> {
  const [row] = await context()
    .db.select({
      subtotalCents: orders.subtotalCents,
      platformFeeCents: orders.platformFeeCents,
      totalCents: orders.totalCents,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
  if (row === undefined) {
    throw new Error('order disappeared')
  }
  return row
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

async function getOrderPage(
  params: Record<string, string>,
  userId: number = context().seed.providerUserId,
): Promise<ProviderOrderListPageDto> {
  const response = await getOrders(params, userId)
  expect(response.status).toBe(200)
  return expectOrderListPage(response.body)
}

async function providerSummaries(): Promise<ProviderOrderSummaryDto[]> {
  const response = await context()
    .request.get('/api/orders')
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(response.status).toBe(200)
  return expectProviderSummaries(response.body)
}

async function patientSummaries(): Promise<PatientOrderSummaryDto[]> {
  const response = await context()
    .request.get('/api/orders')
    .set(USER_ID_HEADER, String(context().seed.patientUserId))
  expect(response.status).toBe(200)
  return expectPatientSummaries(response.body)
}

beforeAll(async () => {
  holder.ctx = await createInternalTestContext()
})

beforeEach(async () => {
  await context().reset()
})

afterAll(async () => {
  if (holder.ctx) {
    await holder.ctx.close()
  }
})

describe('DELETE /api/orders/:id', () => {
  it("deletes the provider's own draft and drops it from the draft list", async () => {
    const kept = await createDraft()
    const doomed = await createDraft()

    const response = await deleteOrder(doomed.id, context().seed.providerUserId)
    expectNoContent(response)

    const missing = await context()
      .request.get(`/api/orders/${doomed.id}`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expectError(
      { status: missing.status, body: missing.body },
      404,
      'NOT_FOUND',
    )

    const summaries = await providerSummaries()
    const summaryIds = summaries.map((order) => order.id)
    expect(summaryIds).toContain(kept.id)
    expect(summaryIds).not.toContain(doomed.id)

    const drafts = await getOrderPage({ status: 'draft', limit: '100' })
    expect(drafts.total).toBe(1)
    expect(idsOf(drafts)).toEqual([kept.id])
    expect(requireListItem(drafts, kept.id).status).toBe('draft')
  })

  it('refuses to delete a pending, paid, or cancelled order', async () => {
    const pending = await placePayableOrder()
    const paid = await placePaid()
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.sentAt).not.toBeNull()
    const cancelledDraft = await cancelOrder((await savePricedDraft()).id)
    expect(cancelledDraft.sentAt).toBeNull()

    const pendingDelete = await deleteOrder(
      pending.detail.id,
      context().seed.providerUserId,
    )
    const paidDelete = await deleteOrder(
      paid.detail.id,
      context().seed.providerUserId,
    )
    const cancelledDelete = await deleteOrder(
      cancelled.id,
      context().seed.providerUserId,
    )
    const unsentDelete = await deleteOrder(
      cancelledDraft.id,
      context().seed.providerUserId,
    )

    expectError(
      { status: pendingDelete.status, body: pendingDelete.body },
      409,
      'ORDER_NOT_DRAFT',
    )
    expectError(
      { status: paidDelete.status, body: paidDelete.body },
      409,
      'ORDER_NOT_DRAFT',
    )
    expectError(
      { status: cancelledDelete.status, body: cancelledDelete.body },
      409,
      'ORDER_NOT_DRAFT',
    )
    expectError(
      { status: unsentDelete.status, body: unsentDelete.body },
      409,
      'ORDER_NOT_DRAFT',
    )

    expect((await getProviderOrder(pending.detail.id)).status).toBe(
      'pending_payment',
    )
    expect((await getProviderOrder(paid.detail.id)).status).toBe('paid')
    expect((await getProviderOrder(cancelled.id)).status).toBe('cancelled')
    expect((await getProviderOrder(cancelledDraft.id)).status).toBe('cancelled')
  })

  it('forbids a patient and another provider, and rejects an unknown user', async () => {
    const draft = await createDraft()
    const patient = await deleteOrder(draft.id, context().seed.patientUserId)
    expectError(
      { status: patient.status, body: patient.body },
      403,
      'FORBIDDEN',
    )

    const other = await deleteOrder(
      draft.id,
      context().seed.otherProviderUserId,
    )
    expectError({ status: other.status, body: other.body }, 403, 'FORBIDDEN')

    const missing = await deleteOrder(draft.id)
    expectError(
      { status: missing.status, body: missing.body },
      401,
      'UNAUTHENTICATED',
    )

    const users = await listUsers()
    const unknownId =
      users.reduce((highest, user) => Math.max(highest, user.id), 0) + 1
    const unknown = await deleteOrder(draft.id, unknownId)
    expectError(
      { status: unknown.status, body: unknown.body },
      401,
      'UNAUTHENTICATED',
    )

    const current = await getProviderOrder(draft.id)
    expect(current.status).toBe('draft')
    expect(current.lines).toEqual(draft.lines)
  })
})

describe('POST /api/orders/:id/reopen', () => {
  it('reopens a cancelled sent order, clears the snapshot, and hides it from the patient', async () => {
    const before = stockPairs(await listProducts())
    const placed = await placePayableOrder()
    const cancelled = await cancelOrder(placed.detail.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.sentAt).not.toBeNull()
    expect(cancelled.cancelledAt).not.toBeNull()
    expect(requireSplit(cancelled)).toEqual(placed.detail.split)
    const snapshot = await storedTotals(cancelled.id)
    expect(snapshot.totalCents).toBe(12_000)
    expect(snapshot.subtotalCents).toBe(12_000)
    expect(snapshot.platformFeeCents).toBe(90)

    const seen = await patientSummaries()
    expect(seen.map((order) => order.id)).toContain(cancelled.id)

    const response = await reopenOrder(
      cancelled.id,
      context().seed.providerUserId,
    )
    expect(response.status).toBe(200)
    const draft = expectProviderDetail(response.body)
    expect(draft.id).toBe(cancelled.id)
    expect(draft.status).toBe('draft')
    expect(draft.sentAt).toBeNull()
    expect(draft.cancelledAt).toBeNull()
    expect(draft.paidAt).toBeNull()
    expect(draft.payment).toBeNull()
    expect(draft.ledger).toEqual([])
    expect(draft.lines).toEqual(cancelled.lines)
    expect(draft.split).toEqual(cancelled.split)
    expect(await storedTotals(draft.id)).toEqual({
      subtotalCents: null,
      platformFeeCents: null,
      totalCents: null,
    })
    expect(stockPairs(await listProducts())).toEqual(before)

    const hiddenList = await patientSummaries()
    expect(hiddenList.map((order) => order.id)).not.toContain(draft.id)
    const hidden = await context()
      .request.get(`/api/orders/${draft.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expectError({ status: hidden.status, body: hidden.body }, 404, 'NOT_FOUND')

    const stillThere = await getProviderOrder(draft.id)
    expect(stillThere.status).toBe('draft')
    expect(stillThere.lines).toEqual(cancelled.lines)
  })

  it('sends the reopened draft again and lets the patient pay', async () => {
    const placed = await placePayableOrder()
    const productId = placed.line.productId
    const before = stockOf(await listProducts(), productId)
    const cancelled = await cancelOrder(placed.detail.id)

    const response = await reopenOrder(
      cancelled.id,
      context().seed.providerUserId,
    )
    expect(response.status).toBe(200)
    const draft = expectProviderDetail(response.body)
    expect(draft.status).toBe('draft')

    const sent = await sendOrderFor(context().seed.providerUserId, draft.id)
    expect(sent.status).toBe('pending_payment')
    expect(sent.sentAt).not.toBeNull()
    expect(sent.cancelledAt).toBeNull()
    expect(sent.paidAt).toBeNull()
    expect(sent.split).toEqual(placed.detail.split)
    expect(sent.lines.map((line) => line.productId)).toEqual(
      cancelled.lines.map((line) => line.productId),
    )

    const visible = await patientSummaries()
    expect(visible.map((order) => order.id)).toContain(sent.id)
    expect(visible.find((order) => order.id === sent.id)?.status).toBe(
      'pending_payment',
    )

    const paid = await pay(sent.id)
    expect(paid.status).toBe(200)
    const patientBody = asRecord(paid.body)
    expect(patientBody.status).toBe('paid')
    expect(patientBody.payment).not.toBeNull()

    const providerPaid = await getProviderOrder(sent.id)
    expect(providerPaid.status).toBe('paid')
    expect(providerPaid.paidAt).not.toBeNull()
    expect(providerPaid.ledger).toHaveLength(3)
    expect(stockOf(await listProducts(), productId)).toBe(
      before - placed.line.quantity,
    )
  })

  it.each(['draft', 'pending_payment', 'paid'] as const)(
    'refuses to reopen a %s order',
    async (status) => {
      const target = await orderWithStatus(status)
      const stock = stockPairs(await listProducts())

      const response = await reopenOrder(
        target.id,
        context().seed.providerUserId,
      )
      expectError(
        { status: response.status, body: response.body },
        409,
        'ORDER_NOT_REOPENABLE',
      )

      const current = await getProviderOrder(target.id)
      expect(current.status).toBe(status)
      expect(current.sentAt).toBe(target.sentAt)
      expect(current.cancelledAt).toBeNull()
      expect(current.lines).toEqual(target.lines)
      expect(stockPairs(await listProducts())).toEqual(stock)
      if (status === 'paid') {
        expect(current.paidAt).toBe(target.paidAt)
        expect(current.ledger).toEqual(target.ledger)
        expect(current.payment).toEqual(target.payment)
      }
    },
  )

  it('forbids a patient and another provider, and rejects an unknown user', async () => {
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    const patient = await reopenOrder(
      cancelled.id,
      context().seed.patientUserId,
    )
    expectError(
      { status: patient.status, body: patient.body },
      403,
      'FORBIDDEN',
    )

    const other = await reopenOrder(
      cancelled.id,
      context().seed.otherProviderUserId,
    )
    expectError({ status: other.status, body: other.body }, 403, 'FORBIDDEN')

    const missing = await reopenOrder(cancelled.id)
    expectError(
      { status: missing.status, body: missing.body },
      401,
      'UNAUTHENTICATED',
    )

    const users = await listUsers()
    const unknownId =
      users.reduce((highest, user) => Math.max(highest, user.id), 0) + 1
    const unknown = await reopenOrder(cancelled.id, unknownId)
    expectError(
      { status: unknown.status, body: unknown.body },
      401,
      'UNAUTHENTICATED',
    )

    const current = await getProviderOrder(cancelled.id)
    expect(current.status).toBe('cancelled')
    expect(current.cancelledAt).toBe(cancelled.cancelledAt)
    expect(current.sentAt).toBe(cancelled.sentAt)
  })
})

describe('GET /api/orders?status=', () => {
  it('filters every status and all, newest activity first except awaiting payment', async () => {
    const directory = (await getPatients({ limit: '100' })).items
    const paidLow = await placePaid()
    const draftMid = await savePricedDraft()
    const pendingMid = await placePayableOrder()
    const cancelledHigh = await cancelOrder(
      (await placePayableOrder()).detail.id,
    )
    const draftLate = await savePricedDraft()
    const unsent = await cancelOrder((await savePricedDraft()).id)
    const paidOld = await placePaid()

    await stampOrder(paidLow.detail.id, {
      createdAt: JAN,
      sentAt: JAN_SENT,
      paidAt: SEP,
    })
    await stampOrder(draftMid.id, { createdAt: FEB })
    await stampOrder(pendingMid.detail.id, { createdAt: JAN, sentAt: MAY })
    await stampOrder(cancelledHigh.id, {
      createdAt: JAN,
      sentAt: JAN_SENT,
      cancelledAt: JUL,
    })
    await stampOrder(draftLate.id, { createdAt: FEB })
    await stampOrder(unsent.id, { createdAt: JAN, cancelledAt: APR })
    await stampOrder(paidOld.detail.id, {
      createdAt: JAN,
      sentAt: AUG,
      paidAt: MAR,
    })

    // paidOld's latest stamp is its August sentAt, which outranks its March
    // paidAt and the July cancellation. The two drafts share February and
    // break that tie by id descending.
    const expectedAll = [
      paidLow.detail.id,
      paidOld.detail.id,
      cancelledHigh.id,
      pendingMid.detail.id,
      unsent.id,
      draftLate.id,
      draftMid.id,
    ]

    const all = await getOrderPage({ status: 'all', limit: '100' })
    expect(all.total).toBe(expectedAll.length)
    expect(all.offset).toBe(0)
    expect(all.limit).toBe(100)
    expect(idsOf(all)).toEqual(expectedAll)
    expectPatientNames(all, directory)

    const defaults = await getOrderPage({ status: 'all' })
    expect(defaults.offset).toBe(0)
    expect(defaults.limit).toBe(25)
    expect(idsOf(defaults)).toEqual(expectedAll)

    const drafts = await getOrderPage({ status: 'draft', limit: '100' })
    expect(idsOf(drafts)).toEqual([draftLate.id, draftMid.id])
    ;[draftLate.id, draftMid.id].forEach((id) => {
      const item = requireListItem(drafts, id)
      expect(item.status).toBe('draft')
      expect(item.totalCents).toBeNull()
      expect(item.sentAt).toBeNull()
      expect(item.paidAt).toBeNull()
      expect(item.cancelledAt).toBeNull()
      expect(item.createdAt).toBe(FEB)
    })

    const pending = await getOrderPage({
      status: 'pending_payment',
      limit: '100',
    })
    expect(idsOf(pending)).toEqual([pendingMid.detail.id])
    const pendingItem = requireListItem(pending, pendingMid.detail.id)
    expect(pendingItem.status).toBe('pending_payment')
    expect(pendingItem.totalCents).toBe(12_000)
    expect(pendingItem.sentAt).toBe(MAY)
    expect(pendingItem.paidAt).toBeNull()
    expect(pendingItem.cancelledAt).toBeNull()

    const paid = await getOrderPage({ status: 'paid', limit: '100' })
    expect(idsOf(paid)).toEqual([paidLow.detail.id, paidOld.detail.id])
    expect(requireListItem(paid, paidLow.detail.id)).toMatchObject({
      status: 'paid',
      totalCents: 12_000,
      sentAt: JAN_SENT,
      paidAt: SEP,
      cancelledAt: null,
    })
    expect(requireListItem(paid, paidOld.detail.id)).toMatchObject({
      status: 'paid',
      totalCents: 12_000,
      sentAt: AUG,
      paidAt: MAR,
      cancelledAt: null,
    })

    const cancelled = await getOrderPage({ status: 'cancelled', limit: '100' })
    expect(idsOf(cancelled)).toEqual([cancelledHigh.id, unsent.id])
    expect(requireListItem(cancelled, cancelledHigh.id)).toMatchObject({
      status: 'cancelled',
      totalCents: 12_000,
      sentAt: JAN_SENT,
      paidAt: null,
      cancelledAt: JUL,
    })
    expect(requireListItem(cancelled, unsent.id)).toMatchObject({
      status: 'cancelled',
      totalCents: null,
      sentAt: null,
      paidAt: null,
      cancelledAt: APR,
    })
  })

  it('lists awaiting payment oldest sent first, then id, and pages it', async () => {
    const directory = (await getPatients({ limit: '100' })).items
    const later = await placePayableOrder()
    const earlyLow = await placePayableOrder()
    const earlyHigh = await placePayableOrder()
    await stampOrder(later.detail.id, { sentAt: MAY })
    await stampOrder(earlyLow.detail.id, { sentAt: JAN })
    await stampOrder(earlyHigh.detail.id, { sentAt: JAN })
    const expected = [earlyLow.detail.id, earlyHigh.detail.id, later.detail.id]

    const all = await getOrderPage({ status: 'pending_payment', limit: '100' })
    expect(idsOf(all)).toEqual(expected)
    expect(all.items.map((item) => item.sentAt)).toEqual([JAN, JAN, MAY])
    expectPatientNames(all, directory)
    expect(all.items.every((item) => item.patientName.length > 0)).toBe(true)
    expect(all.items.every((item) => item.patientDateOfBirth.length > 0)).toBe(
      true,
    )

    const page0 = await getOrderPage({
      status: 'pending_payment',
      offset: '0',
      limit: '1',
    })
    const page1 = await getOrderPage({
      status: 'pending_payment',
      offset: '1',
      limit: '1',
    })
    const page2 = await getOrderPage({
      status: 'pending_payment',
      offset: '2',
      limit: '1',
    })
    const past = await getOrderPage({
      status: 'pending_payment',
      offset: '3',
      limit: '1',
    })
    expect(idsOf(page0)).toEqual([earlyLow.detail.id])
    expect(page0).toMatchObject({ total: 3, offset: 0, limit: 1 })
    expect(idsOf(page1)).toEqual([earlyHigh.detail.id])
    expect(page1).toMatchObject({ total: 3, offset: 1, limit: 1 })
    expect(idsOf(page2)).toEqual([later.detail.id])
    expect(past).toMatchObject({ items: [], total: 3, offset: 3, limit: 1 })

    const defaults = await getOrderPage({ status: 'pending_payment' })
    expect(defaults.limit).toBe(25)
    expect(defaults.offset).toBe(0)
    expect(idsOf(defaults)).toEqual(expected)
  })

  it('filters a status set, ignores duplicates, and sorts every other set by activity', async () => {
    const paidRecent = await placePaid()
    const pendingEarly = await placePayableOrder()
    const pendingLate = await placePayableOrder()
    const cancelledMid = await cancelOrder(
      (await placePayableOrder()).detail.id,
    )
    const draftOlder = await savePricedDraft()
    const draftNewer = await savePricedDraft()

    await stampOrder(paidRecent.detail.id, {
      createdAt: JAN,
      sentAt: JAN_SENT,
      paidAt: SEP,
    })
    await stampOrder(pendingEarly.detail.id, { createdAt: JAN, sentAt: JAN })
    await stampOrder(pendingLate.detail.id, { createdAt: JAN, sentAt: MAY })
    await stampOrder(cancelledMid.id, {
      createdAt: JAN,
      sentAt: JAN_SENT,
      cancelledAt: JUL,
    })
    await stampOrder(draftOlder.id, { createdAt: FEB })
    await stampOrder(draftNewer.id, { createdAt: JUN })

    // Activity is September paid, July cancelled, June draft, May pending,
    // February draft, January pending. Oldest sent is the reverse of that
    // for the two pending orders.
    const awaitingOldest = [pendingEarly.detail.id, pendingLate.detail.id]
    const exceptPaid = [
      cancelledMid.id,
      draftNewer.id,
      pendingLate.detail.id,
      draftOlder.id,
      pendingEarly.detail.id,
    ]

    async function pageIds(status: string): Promise<number[]> {
      const page = await getOrderPage({ status, limit: '100' })
      expect(page.total).toBe(page.items.length)
      return idsOf(page)
    }

    expect(await pageIds('pending_payment')).toEqual(awaitingOldest)
    // Repeating the only status must not turn it into a multi-status set.
    // A multi-status set would list the May pending order first.
    expect(await pageIds('pending_payment,pending_payment')).toEqual(
      awaitingOldest,
    )
    expect(await pageIds('paid,paid')).toEqual([paidRecent.detail.id])

    const exceptPaidPage = await getOrderPage({
      status: 'draft,pending_payment,cancelled',
      limit: '100',
    })
    expect(exceptPaidPage.total).toBe(exceptPaid.length)
    expect(idsOf(exceptPaidPage)).toEqual(exceptPaid)
    expect(idsOf(exceptPaidPage)).not.toContain(paidRecent.detail.id)
    expect(exceptPaidPage.items.map((item) => item.status)).not.toContain(
      'paid',
    )
    expect(
      await pageIds('cancelled,draft,pending_payment,draft,cancelled'),
    ).toEqual(exceptPaid)

    expect(await pageIds('draft,pending_payment')).toEqual([
      draftNewer.id,
      pendingLate.detail.id,
      draftOlder.id,
      pendingEarly.detail.id,
    ])
    expect(await pageIds('paid,cancelled')).toEqual([
      paidRecent.detail.id,
      cancelledMid.id,
    ])
  })

  it('stays inside the provider and honours patientId', async () => {
    const own = await placePayableOrder()
    const foreignPatientId = await otherProviderPatientId()
    const foreign = await placePayableOrder(
      context().seed.otherProviderUserId,
      foreignPatientId,
    )
    const samId = await patientIdFor(context().seed.otherPatientUserId)
    const sam = await placePayableOrder(context().seed.providerUserId, samId)

    const mine = await getOrderPage({ status: 'pending_payment', limit: '100' })
    expect(idsOf(mine).sort((left, right) => left - right)).toEqual(
      [own.detail.id, sam.detail.id].sort((left, right) => left - right),
    )
    expect(idsOf(mine)).not.toContain(foreign.detail.id)

    const theirs = await getOrderPage(
      { status: 'pending_payment', limit: '100' },
      context().seed.otherProviderUserId,
    )
    expect(idsOf(theirs)).toEqual([foreign.detail.id])

    const jordanOnly = await getOrderPage({
      status: 'pending_payment',
      patientId: String(context().seed.patientId),
      limit: '100',
    })
    expect(idsOf(jordanOnly)).toEqual([own.detail.id])

    const samOnly = await getOrderPage({
      status: 'pending_payment',
      patientId: String(samId),
      limit: '100',
    })
    expect(idsOf(samOnly)).toEqual([sam.detail.id])
    expect(requireListItem(samOnly, sam.detail.id).patientId).toBe(samId)

    const crossed = await getOrders(
      { status: 'pending_payment', patientId: String(foreignPatientId) },
      context().seed.providerUserId,
    )
    expectError(crossed, 403, 'FORBIDDEN')
  })

  it.each<[Record<string, string>, string]>([
    [{ status: 'shipped' }, 'status'],
    [{ status: 'PAID' }, 'status'],
    [{ status: '' }, 'status'],
    [{ status: 'draft,shipped' }, 'status'],
    [{ status: 'paid,PAID' }, 'status'],
    [{ status: 'draft,' }, 'status'],
    [{ status: ',draft' }, 'status'],
    [{ status: 'all,paid' }, 'status'],
    [{ status: 'pending_payment,all' }, 'status'],
    [{ status: 'pending_payment', offset: '-1' }, 'offset'],
    [{ status: 'pending_payment', offset: '1.5' }, 'offset'],
    [{ status: 'all', limit: '0' }, 'limit'],
    [{ status: 'all', limit: '101' }, 'limit'],
    [{ status: 'draft', limit: '1.5' }, 'limit'],
  ])('rejects %j on %s', async (query, field) => {
    const response = await getOrders(query, context().seed.providerUserId)
    expectError(response, 400, 'VALIDATION_ERROR', field)
  })

  it('rejects a patient who passes a status list', async () => {
    const response = await getOrders(
      { status: 'draft,pending_payment,cancelled' },
      context().seed.patientUserId,
    )
    expectError(response, 403, 'FORBIDDEN')
  })
})

describe('GET /api/orders without status', () => {
  it('keeps the provider array and the patient array, and blocks a patient status filter', async () => {
    const openDraft = await savePricedDraft()
    const cancelledDraft = await cancelOrder((await createDraft()).id)
    const pending = await placePayableOrder()
    const cancelled = await cancelOrder((await placePayableOrder()).detail.id)
    const paid = await placePaid()

    const provider = await providerSummaries()
    const providerIds = provider.map((order) => order.id)
    expect(provider).toHaveLength(5)
    expect([...providerIds].sort((left, right) => left - right)).toEqual(
      [
        openDraft.id,
        cancelledDraft.id,
        pending.detail.id,
        cancelled.id,
        paid.detail.id,
      ].sort((left, right) => left - right),
    )
    expect(provider.find((order) => order.id === openDraft.id)?.status).toBe(
      'draft',
    )
    expect(provider.find((order) => order.id === openDraft.id)?.split).toEqual(
      openDraft.split,
    )

    const patient = await patientSummaries()
    const patientIds = patient.map((order) => order.id)
    expect(patient).toHaveLength(3)
    expect([...patientIds].sort((left, right) => left - right)).toEqual(
      [pending.detail.id, cancelled.id, paid.detail.id].sort(
        (left, right) => left - right,
      ),
    )
    expect(patientIds).not.toContain(openDraft.id)
    expect(patientIds).not.toContain(cancelledDraft.id)
    expect(patient.every((order) => order.status !== 'draft')).toBe(true)
    expect(patient.find((order) => order.id === cancelled.id)).toMatchObject({
      status: 'cancelled',
      totalCents: 12_000,
      paidAt: null,
    })

    const filters = ['draft', 'pending_payment', 'paid', 'cancelled', 'all']
    const forbidden = await Promise.all(
      filters.map((status) =>
        getOrders({ status }, context().seed.patientUserId),
      ),
    )
    forbidden.forEach((response) => {
      expectError(response, 403, 'FORBIDDEN')
    })
  })
})

describe('GET /api/patients?latestStatus=', () => {
  it('uses the most recently created order, not an older one', async () => {
    const jordanId = context().seed.patientId
    const samId = await patientIdFor(context().seed.otherPatientUserId)
    const jordanDraft = await savePricedDraft()
    await stampOrder(jordanDraft.id, { createdAt: JUN })
    const jordanPaid = await placePaid()
    await stampOrder(jordanPaid.detail.id, { createdAt: JAN })
    const samCancelled = await cancelOrder(
      (await placePayableOrder(context().seed.providerUserId, samId)).detail.id,
    )
    await stampOrder(samCancelled.id, { createdAt: MAR })

    const directory = await getPatients({ limit: '100' })
    const jordan = directory.items.find((patient) => patient.id === jordanId)
    const sam = directory.items.find((patient) => patient.id === samId)
    if (jordan === undefined || sam === undefined) {
      throw new Error('seed patients missing')
    }
    const shared = sharedLetter(jordan.name, sam.name).toUpperCase()
    const onlyJordan = uniqueLetter(jordan.name, sam.name)

    const draft = await getPatients({ latestStatus: 'draft', limit: '100' })
    expect(draft.total).toBe(1)
    expect(draft.items.map((patient) => patient.id)).toEqual([jordanId])
    expect(firstPatient(draft)).toMatchObject({
      orderCount: 2,
      latestOrderStatus: 'draft',
    })

    const paid = await getPatients({ latestStatus: 'paid', limit: '100' })
    expect(paid).toMatchObject({ items: [], total: 0 })

    const pending = await getPatients({
      latestStatus: 'pending_payment',
      limit: '100',
    })
    expect(pending).toMatchObject({ items: [], total: 0 })

    const cancelled = await getPatients({
      latestStatus: 'cancelled',
      limit: '100',
    })
    expect(cancelled.total).toBe(1)
    expect(cancelled.items.map((patient) => patient.id)).toEqual([samId])
    expect(firstPatient(cancelled)).toMatchObject({
      orderCount: 1,
      latestOrderStatus: 'cancelled',
    })

    const none = await getPatients({ latestStatus: 'none', limit: '100' })
    expect(none).toMatchObject({ items: [], total: 0 })

    const draftSearch = await getPatients({
      latestStatus: 'draft',
      q: shared,
      limit: '100',
    })
    expect(draftSearch.items.map((patient) => patient.id)).toEqual([jordanId])
    expect(draftSearch.total).toBe(1)

    const cancelledSearch = await getPatients({
      latestStatus: 'cancelled',
      q: shared,
      limit: '100',
    })
    expect(cancelledSearch.items.map((patient) => patient.id)).toEqual([samId])

    const nameOnly = await getPatients({ q: shared, limit: '100' })
    expect(nameOnly.items.map((patient) => patient.id)).toEqual(
      directory.items
        .filter((patient) =>
          patient.name.toLowerCase().includes(shared.toLowerCase()),
        )
        .map((patient) => patient.id),
    )
    expect(nameOnly.total).toBeGreaterThanOrEqual(2)

    const mismatched = await getPatients({
      latestStatus: 'cancelled',
      q: onlyJordan,
      limit: '100',
    })
    expect(mismatched).toMatchObject({ items: [], total: 0 })
  })

  it('returns pending and paid patients when that order is the latest', async () => {
    const jordanId = context().seed.patientId
    const samId = await patientIdFor(context().seed.otherPatientUserId)
    await placePayableOrder()
    await placePaid(
      context().seed.providerUserId,
      samId,
      context().seed.otherPatientUserId,
    )

    const pending = await getPatients({
      latestStatus: 'pending_payment',
      limit: '100',
    })
    expect(pending.items.map((patient) => patient.id)).toEqual([jordanId])
    expect(firstPatient(pending).latestOrderStatus).toBe('pending_payment')
    expect(pending.total).toBe(1)

    const paid = await getPatients({ latestStatus: 'paid', limit: '100' })
    expect(paid.items.map((patient) => patient.id)).toEqual([samId])
    expect(firstPatient(paid).latestOrderStatus).toBe('paid')
    expect(paid.total).toBe(1)

    const draft = await getPatients({ latestStatus: 'draft', limit: '100' })
    expect(draft).toMatchObject({ items: [], total: 0 })
  })

  it('returns only patients with no orders for latestStatus=none', async () => {
    const samId = await patientIdFor(context().seed.otherPatientUserId)
    await savePricedDraft()

    const none = await getPatients({ latestStatus: 'none', limit: '100' })
    expect(none.total).toBe(1)
    expect(none.items.map((patient) => patient.id)).toEqual([samId])
    expect(firstPatient(none)).toMatchObject({
      orderCount: 0,
      latestOrderStatus: null,
    })

    const everyone = await getPatients({ limit: '100' })
    expect(everyone.total).toBeGreaterThan(none.total)
    expect(everyone.items.map((patient) => patient.id)).toContain(
      context().seed.patientId,
    )
  })

  it.each(['all', 'any', ''])(
    'rejects latestStatus %j',
    async (latestStatus) => {
      const response = await getPatientsRaw(
        { latestStatus },
        context().seed.providerUserId,
      )
      expectError(response, 400, 'VALIDATION_ERROR', 'latestStatus')
    },
  )
})
