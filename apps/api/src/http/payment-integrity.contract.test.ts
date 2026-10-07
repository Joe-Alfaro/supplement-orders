import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LINE_QUANTITY,
  MAX_UNIT_PRICE_CENTS,
  USER_ID_HEADER,
  apiErrorResponseSchema,
  dashboardDtoSchema,
  patientOrderDetailDtoSchema,
  patientOrderSummaryDtoSchema,
  providerOrderDetailDtoSchema,
  providerOrderSummaryDtoSchema,
} from '@supplement-orders/domain'
import type { PatientOrderDetailDto, PayOrderRequest } from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Revision 9, black-box. Pay is PayOrderRequest: the revision and total the
// patient saw. Draft lines use the domain bounds. Order and dashboard bodies
// are the domain DTOs. The dashboard no longer returns paidOrders.

const ORDER_CHANGED =
  'This order changed since you opened it. Review the new total before paying.'

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
  'revision',
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
  'revision',
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

const DASHBOARD_KEYS = [
  'gmvCents',
  'providerMarginCents',
  'platformFeeCents',
  'range',
]

interface ContextHolder {
  ctx?: TestContext
}

interface HttpResult {
  status: number
  body: unknown
}

interface SendableProduct {
  id: number
  cogsCents: number
}

interface PricedOrder {
  orderId: number
  productId: number
  firstTotalCents: number
  revisedTotalCents: number
}

interface DraftCase {
  label: string
  quantity: number
  unitPriceCents: number
  field: string
}

interface PayFieldCase {
  label: string
  body: Record<string, unknown>
  field: string
}

interface SavedLine {
  productId: number
  quantity: number
  unitPriceCents: number
}

const FIRST_TOTAL_CENTS = 2_000
const REVISED_TOTAL_CENTS = 3_000

const DRAFT_CASES: readonly DraftCase[] = [
  {
    label: 'quantity 0',
    quantity: 0,
    unitPriceCents: FIRST_TOTAL_CENTS,
    field: 'lines.0.quantity',
  },
  {
    label: 'quantity 1001',
    quantity: MAX_LINE_QUANTITY + 1,
    unitPriceCents: FIRST_TOTAL_CENTS,
    field: 'lines.0.quantity',
  },
  {
    label: 'quantity 2147483648',
    quantity: 2_147_483_648,
    unitPriceCents: FIRST_TOTAL_CENTS,
    field: 'lines.0.quantity',
  },
  {
    label: 'unitPriceCents 1000001',
    quantity: 1,
    unitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
    field: 'lines.0.unitPriceCents',
  },
  {
    label: 'unitPriceCents MAX_SAFE_INTEGER',
    quantity: 1,
    unitPriceCents: Number.MAX_SAFE_INTEGER,
    field: 'lines.0.unitPriceCents',
  },
]

const PAY_FIELD_CASES: readonly PayFieldCase[] = [
  { label: 'missing both fields', body: {}, field: 'expectedRevision' },
  {
    label: 'missing expectedRevision',
    body: { expectedTotalCents: FIRST_TOTAL_CENTS },
    field: 'expectedRevision',
  },
  {
    label: 'missing expectedTotalCents',
    body: { expectedRevision: 1 },
    field: 'expectedTotalCents',
  },
  {
    label: 'expectedRevision 0',
    body: { expectedRevision: 0, expectedTotalCents: FIRST_TOTAL_CENTS },
    field: 'expectedRevision',
  },
  {
    label: 'fractional expectedRevision',
    body: { expectedRevision: 1.5, expectedTotalCents: FIRST_TOTAL_CENTS },
    field: 'expectedRevision',
  },
  {
    label: 'negative expectedTotalCents',
    body: { expectedRevision: 1, expectedTotalCents: -1 },
    field: 'expectedTotalCents',
  },
  {
    label: 'fractional expectedTotalCents',
    body: { expectedRevision: 1, expectedTotalCents: 10.5 },
    field: 'expectedTotalCents',
  },
]

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

function actor(userId: number): Record<string, string> {
  return { [USER_ID_HEADER]: String(userId) }
}

function providerActor(): Record<string, string> {
  return actor(context().seed.providerUserId)
}

function patientActor(): Record<string, string> {
  return actor(context().seed.patientUserId)
}

function expectExactKeys(value: unknown, keys: readonly string[]): void {
  expect(Object.keys(asRecord(value)).sort()).toEqual([...keys].sort())
}

function parsedRevision(body: unknown): number {
  const record = asRecord(body)
  if (record.view === 'provider' && 'ledger' in record) {
    return providerOrderDetailDtoSchema.parse(body).revision
  }
  if (record.view === 'provider') {
    return providerOrderSummaryDtoSchema.parse(body).revision
  }
  if ('patientAddress' in record) {
    return patientOrderDetailDtoSchema.parse(body).revision
  }
  return patientOrderSummaryDtoSchema.parse(body).revision
}

function expectRevision(body: unknown, revision: number): void {
  expect(parsedRevision(body)).toBe(revision)
}

function expectOrderChanged(response: HttpResult): void {
  expect(response.status).toBe(409)
  const parsed = apiErrorResponseSchema.parse(response.body)
  expect(parsed.error.code).toBe('ORDER_CHANGED')
  expect(parsed.error.message).toBe(ORDER_CHANGED)
  expect(parsed.error.field).toBeUndefined()
  expectExactKeys(response.body, ['error'])
  expect(Object.keys(asRecord(asRecord(response.body).error)).sort()).toEqual([
    'code',
    'message',
  ])
}

function expectFieldError(response: HttpResult, field: string): void {
  expect(response.status).toBe(400)
  const parsed = apiErrorResponseSchema.parse(response.body)
  expect(parsed.error.code).toBe('VALIDATION_ERROR')
  expect(parsed.error.message.length).toBeGreaterThan(0)
  expect(parsed.error.field).toBe(field)
  expectExactKeys(response.body, ['error'])
  expect(Object.keys(asRecord(asRecord(response.body).error)).sort()).toEqual([
    'code',
    'field',
    'message',
  ])
}

function result(response: { status: number; body: unknown }): HttpResult {
  return { status: response.status, body: response.body }
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

function sendableProduct(unitPriceCents: number): SendableProduct {
  const product = context().seed.products.find(
    (item) => minUnitPriceCents(item.cogsCents) <= unitPriceCents,
  )
  if (!product) {
    throw new Error(
      `seed has no product that can be sent at ${unitPriceCents} cents`,
    )
  }
  return product
}

function numberField(body: unknown, field: string): number {
  const value = asRecord(body)[field]
  if (typeof value !== 'number') {
    throw new Error(`${field} was not a number`)
  }
  return value
}

function providerTotal(body: unknown): number {
  return numberField(asRecord(body).split, 'totalCents')
}

function lineStock(body: unknown): number {
  const lines = asRecord(body).lines
  if (!Array.isArray(lines) || lines[0] === undefined) {
    throw new Error('provider detail has no lines')
  }
  return numberField(lines[0], 'stockQuantity')
}

function savedLine(body: unknown): SavedLine {
  const lines = asRecord(body).lines
  if (!Array.isArray(lines) || lines[0] === undefined) {
    throw new Error('draft has no lines')
  }
  const line = asRecord(lines[0])
  const productId = line.productId
  const quantity = line.quantity
  const unitPriceCents = line.unitPriceCents
  if (
    typeof productId !== 'number' ||
    typeof quantity !== 'number' ||
    typeof unitPriceCents !== 'number'
  ) {
    throw new Error('draft line is incomplete')
  }
  return { productId, quantity, unitPriceCents }
}

function findOrder(body: unknown, orderId: number): Record<string, unknown> {
  if (!Array.isArray(body)) {
    throw new Error('expected an order list')
  }
  const found = body.find((item) => asRecord(item).id === orderId)
  if (found === undefined) {
    throw new Error(`order ${orderId} was not in the list`)
  }
  return asRecord(found)
}

async function createDraft(): Promise<HttpResult> {
  return result(
    await context()
      .request.post('/api/orders')
      .set(providerActor())
      .send({ patientId: context().seed.patientId }),
  )
}

async function putLines(
  orderId: number,
  lines: readonly {
    productId: number
    quantity: number
    unitPriceCents: number
  }[],
): Promise<HttpResult> {
  return result(
    await context()
      .request.put(`/api/orders/${orderId}/lines`)
      .set(providerActor())
      .send({ lines }),
  )
}

async function sendOrder(orderId: number): Promise<HttpResult> {
  return result(
    await context()
      .request.post(`/api/orders/${orderId}/send`)
      .set(providerActor()),
  )
}

async function cancelOrder(orderId: number): Promise<HttpResult> {
  return result(
    await context()
      .request.post(`/api/orders/${orderId}/cancel`)
      .set(providerActor()),
  )
}

async function reopenOrder(orderId: number): Promise<HttpResult> {
  return result(
    await context()
      .request.post(`/api/orders/${orderId}/reopen`)
      .set(providerActor()),
  )
}

async function getProvider(orderId: number): Promise<HttpResult> {
  return result(
    await context().request.get(`/api/orders/${orderId}`).set(providerActor()),
  )
}

async function getPatient(orderId: number): Promise<HttpResult> {
  return result(
    await context().request.get(`/api/orders/${orderId}`).set(patientActor()),
  )
}

function quote(
  expectedRevision: number,
  expectedTotalCents: number,
): PayOrderRequest {
  return { expectedRevision, expectedTotalCents }
}

async function pay(
  orderId: number,
  body: PayOrderRequest | Record<string, unknown>,
): Promise<HttpResult> {
  return result(
    await context()
      .request.post(`/api/orders/${orderId}/pay`)
      .set(patientActor())
      .send(body),
  )
}

async function gmvCents(): Promise<number> {
  const response = await context()
    .request.get('/api/dashboard')
    .set(providerActor())
  expect(response.status).toBe(200)
  return numberField(response.body, 'gmvCents')
}

async function placeAt(unitPriceCents: number): Promise<PricedOrder> {
  const product = sendableProduct(unitPriceCents)
  const created = await createDraft()
  expect(created.status).toBe(201)
  const orderId = numberField(created.body, 'id')
  const saved = await putLines(orderId, [
    { productId: product.id, quantity: 1, unitPriceCents },
  ])
  expect(saved.status).toBe(200)
  const sent = await sendOrder(orderId)
  expect(sent.status).toBe(200)
  expect(providerTotal(sent.body)).toBe(unitPriceCents)
  return {
    orderId,
    productId: product.id,
    firstTotalCents: unitPriceCents,
    revisedTotalCents: REVISED_TOTAL_CENTS,
  }
}

async function repriceAndResend(order: PricedOrder): Promise<void> {
  const cancelled = await cancelOrder(order.orderId)
  expect(cancelled.status).toBe(200)
  expect(asRecord(cancelled.body).status).toBe('cancelled')
  const reopened = await reopenOrder(order.orderId)
  expect(reopened.status).toBe(200)
  expect(asRecord(reopened.body).status).toBe('draft')
  const repriced = await putLines(order.orderId, [
    {
      productId: order.productId,
      quantity: 1,
      unitPriceCents: order.revisedTotalCents,
    },
  ])
  expect(repriced.status).toBe(200)
  const resent = await sendOrder(order.orderId)
  expect(resent.status).toBe(200)
  expect(asRecord(resent.body).status).toBe('pending_payment')
  expect(providerTotal(resent.body)).toBe(order.revisedTotalCents)
}

describe('payment integrity over HTTP', () => {
  beforeAll(async () => {
    holder.ctx = await createTestContext()
  })
  beforeEach(async () => {
    await context().reset()
  })
  afterAll(async () => {
    await context().close()
  })

  it('starts at revision 0 and increments on every send, on both order DTOs', async () => {
    const product = sendableProduct(FIRST_TOTAL_CENTS)
    const created = await createDraft()
    expect(created.status).toBe(201)
    expectExactKeys(created.body, PROVIDER_DETAIL_KEYS)
    expect(asRecord(created.body).view).toBe('provider')
    expectRevision(created.body, 0)
    const orderId = numberField(created.body, 'id')

    const saved = await putLines(orderId, [
      { productId: product.id, quantity: 1, unitPriceCents: FIRST_TOTAL_CENTS },
    ])
    expect(saved.status).toBe(200)
    expectExactKeys(saved.body, PROVIDER_DETAIL_KEYS)
    expectRevision(saved.body, 0)

    const sent = await sendOrder(orderId)
    expect(sent.status).toBe(200)
    expectExactKeys(sent.body, PROVIDER_DETAIL_KEYS)
    expectRevision(sent.body, 1)

    const provider = await getProvider(orderId)
    expect(provider.status).toBe(200)
    expectExactKeys(provider.body, PROVIDER_DETAIL_KEYS)
    expectRevision(provider.body, 1)
    const providerList = result(
      await context().request.get('/api/orders').set(providerActor()),
    )
    expect(providerList.status).toBe(200)
    const providerItem = findOrder(providerList.body, orderId)
    expectExactKeys(providerItem, PROVIDER_SUMMARY_KEYS)
    expect(providerItem.view).toBe('provider')
    expect(providerItem.revision).toBe(1)

    const patient = await getPatient(orderId)
    expect(patient.status).toBe(200)
    expectExactKeys(patient.body, PATIENT_DETAIL_KEYS)
    expect(asRecord(patient.body).view).toBe('patient')
    expectRevision(patient.body, 1)
    const patientList = result(
      await context().request.get('/api/orders').set(patientActor()),
    )
    expect(patientList.status).toBe(200)
    const patientItem = findOrder(patientList.body, orderId)
    expectExactKeys(patientItem, PATIENT_SUMMARY_KEYS)
    expect(patientItem.view).toBe('patient')
    expect(patientItem.revision).toBe(1)

    const cancelled = await cancelOrder(orderId)
    expect(cancelled.status).toBe(200)
    expectExactKeys(cancelled.body, PROVIDER_DETAIL_KEYS)
    expectRevision(cancelled.body, 1)
    const reopened = await reopenOrder(orderId)
    expect(reopened.status).toBe(200)
    expectExactKeys(reopened.body, PROVIDER_DETAIL_KEYS)
    expectRevision(reopened.body, 1)
    const repriced = await putLines(orderId, [
      {
        productId: product.id,
        quantity: 1,
        unitPriceCents: REVISED_TOTAL_CENTS,
      },
    ])
    expect(repriced.status).toBe(200)
    expectRevision(repriced.body, 1)
    const resent = await sendOrder(orderId)
    expect(resent.status).toBe(200)
    expectExactKeys(resent.body, PROVIDER_DETAIL_KEYS)
    expectRevision(resent.body, 2)
    const patientAgain = await getPatient(orderId)
    expect(patientAgain.status).toBe(200)
    expectExactKeys(patientAgain.body, PATIENT_DETAIL_KEYS)
    expectRevision(patientAgain.body, 2)
    expect(numberField(patientAgain.body, 'totalCents')).toBe(
      REVISED_TOTAL_CENTS,
    )
  })

  it('rejects a stale pay after cancel, reopen, reprice, and resend without charging', async () => {
    const order = await placeAt(FIRST_TOTAL_CENTS)
    const patientBefore = await getPatient(order.orderId)
    expect(numberField(patientBefore.body, 'totalCents')).toBe(
      order.firstTotalCents,
    )
    await repriceAndResend(order)
    const stockBefore = lineStock((await getProvider(order.orderId)).body)
    const gmvBefore = await gmvCents()

    const rejected = await pay(order.orderId, quote(1, order.firstTotalCents))

    expectOrderChanged(rejected)
    const patient = await getPatient(order.orderId)
    expect(patient.status).toBe(200)
    expect(asRecord(patient.body).status).toBe('pending_payment')
    expect(numberField(patient.body, 'totalCents')).toBe(
      order.revisedTotalCents,
    )
    expect(asRecord(patient.body).payment).toBeNull()
    expect(lineStock((await getProvider(order.orderId)).body)).toBe(stockBefore)
    expect(await gmvCents()).toBe(gmvBefore)
  })

  it('charges the total the patient confirms with the current revision', async () => {
    const order = await placeAt(FIRST_TOTAL_CENTS)
    await repriceAndResend(order)
    const gmvBefore = await gmvCents()

    const paid = await pay(order.orderId, quote(2, order.revisedTotalCents))

    expect(paid.status).toBe(200)
    expectExactKeys(paid.body, PATIENT_DETAIL_KEYS)
    expectRevision(paid.body, 2)
    const detail: PatientOrderDetailDto = patientOrderDetailDtoSchema.parse(
      paid.body,
    )
    expect(detail.view).toBe('patient')
    expect(detail.status).toBe('paid')
    expect(detail.totalCents).toBe(order.revisedTotalCents)
    expect(detail.payment?.amountCents).toBe(order.revisedTotalCents)
    const provider = await getProvider(order.orderId)
    expect(provider.status).toBe(200)
    expectExactKeys(provider.body, PROVIDER_DETAIL_KEYS)
    expectRevision(provider.body, 2)
    expect(asRecord(asRecord(provider.body).payment).amountCents).toBe(
      order.revisedTotalCents,
    )
    expect(await gmvCents()).toBe(gmvBefore + order.revisedTotalCents)
  })

  it('replays a paid order only when the revision and total still match', async () => {
    const order = await placeAt(FIRST_TOTAL_CENTS)
    await repriceAndResend(order)
    const confirmed = quote(2, order.revisedTotalCents)
    const paid = await pay(order.orderId, confirmed)
    expect(paid.status).toBe(200)
    const payment = asRecord(paid.body).payment
    const paidId = numberField(payment, 'id')
    const gmvAfterPay = await gmvCents()

    const replay = await pay(order.orderId, confirmed)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(paid.body)

    const wrongRevision = await pay(
      order.orderId,
      quote(1, order.revisedTotalCents),
    )
    expectOrderChanged(wrongRevision)
    const wrongTotal = await pay(order.orderId, quote(2, order.firstTotalCents))
    expectOrderChanged(wrongTotal)

    const patient = await getPatient(order.orderId)
    expect(numberField(asRecord(patient.body).payment, 'id')).toBe(paidId)
    expect(await gmvCents()).toBe(gmvAfterPay)
  })

  it.each(PAY_FIELD_CASES)(
    'pay $label -> 400 $field and does not charge',
    async ({ body, field }) => {
      const order = await placeAt(FIRST_TOTAL_CENTS)
      const gmvBefore = await gmvCents()

      const rejected = await pay(order.orderId, body)

      expectFieldError(rejected, field)
      const patient = await getPatient(order.orderId)
      expect(patient.status).toBe(200)
      expect(asRecord(patient.body).status).toBe('pending_payment')
      expect(asRecord(patient.body).payment).toBeNull()
      expect(await gmvCents()).toBe(gmvBefore)
    },
  )

  it.each(DRAFT_CASES)(
    'saving $label -> 400 $field and leaves the previous draft',
    async ({ quantity, unitPriceCents, field }) => {
      const product = context().seed.products[0]
      if (!product) {
        throw new Error('seed has no product')
      }
      const created = await createDraft()
      expect(created.status).toBe(201)
      const orderId = numberField(created.body, 'id')
      const saved = await putLines(orderId, [
        {
          productId: product.id,
          quantity: 1,
          unitPriceCents: FIRST_TOTAL_CENTS,
        },
      ])
      expect(saved.status).toBe(200)
      const before = await getProvider(orderId)
      expect(before.status).toBe(200)
      const previous = savedLine(before.body)

      const rejected = await putLines(orderId, [
        { productId: product.id, quantity, unitPriceCents },
      ])

      expectFieldError(rejected, field)
      const after = await getProvider(orderId)
      expect(after.status).toBe(200)
      expect(asRecord(after.body).status).toBe('draft')
      expect(savedLine(after.body)).toEqual(previous)
    },
  )

  it('returns the dashboard totals without paidOrders', async () => {
    const response = result(
      await context().request.get('/api/dashboard').set(providerActor()),
    )
    expect(response.status).toBe(200)
    expectExactKeys(response.body, DASHBOARD_KEYS)
    expect(asRecord(response.body).paidOrders).toBeUndefined()
    const dashboard = dashboardDtoSchema.parse(response.body)
    expect(Number.isInteger(dashboard.gmvCents)).toBe(true)
    expect(Number.isInteger(dashboard.providerMarginCents)).toBe(true)
    expect(Number.isInteger(dashboard.platformFeeCents)).toBe(true)
  })
})
