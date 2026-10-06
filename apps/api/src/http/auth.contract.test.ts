import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  USER_ID_HEADER,
  apiErrorResponseSchema,
  patientOrderDetailDtoSchema,
  patientOrderSummaryDtoSchema,
  productDtoSchema,
  providerOrderDetailDtoSchema,
  providerOrderSummaryDtoSchema,
  userDtoSchema,
} from '@supplement-orders/domain'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  PatientOrderDetailDto,
  PatientOrderSummaryDto,
  ProviderOrderDetailDto,
  ProviderOrderSummaryDto,
  UserDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Persona checks use the stored role from X-User-Id. The client never sends a
// role.
// A draft is not in the patient's resource set, so reading it is 404.
// Another person's order is 403, which the error map reserves for that case.
// A non-numeric X-User-Id is unspecified and is not asserted here.
// The patient summary is a single totalCents: the subtotal, with no fee or margin.

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

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

const PROVIDER_DETAIL_KEYS = [
  ...PROVIDER_SUMMARY_KEYS,
  'patientDateOfBirth',
  'patientAddress',
  'lines',
  'payment',
  'ledger',
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

interface ContextHolder {
  ctx?: TestContext
}

interface ExampleLine {
  productId: number
  quantity: number
  unitPriceCents: number
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
  return patientOrderDetailDtoSchema.parse(body)
}

function expectPatientSummaries(body: unknown): PatientOrderSummaryDto[] {
  if (!Array.isArray(body)) {
    throw new Error('order list must be an array')
  }
  body.forEach((order) => {
    expectExactKeys(order, PATIENT_SUMMARY_KEYS)
  })
  return z.array(patientOrderSummaryDtoSchema).parse(body)
}

function expectProviderSummaries(body: unknown): ProviderOrderSummaryDto[] {
  if (!Array.isArray(body)) {
    throw new Error('order list must be an array')
  }
  body.forEach((order) => {
    expectExactKeys(order, PROVIDER_SUMMARY_KEYS)
    const split = asRecord(order).split
    if (split === null) {
      expect(split).toBeNull()
    } else {
      expectExactKeys(split, SPLIT_KEYS)
    }
  })
  return z.array(providerOrderSummaryDtoSchema).parse(body)
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

function exampleLine(): ExampleLine {
  // $120.00 can be sent only when the minimum for that cost is at most $120.00.
  const product = context().seed.products.find(
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
  }
}

async function createDraft(): Promise<ProviderOrderDetailDto> {
  const response = await context()
    .request.post('/api/orders')
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
    .send({ patientId: context().seed.patientId })
  expect(response.status).toBe(201)
  return expectProviderDetail(response.body)
}

async function sendDraft(orderId: number): Promise<ProviderOrderDetailDto> {
  const line = exampleLine()
  const replaced = await context()
    .request.put(`/api/orders/${orderId}/lines`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
    .send({
      lines: [
        {
          productId: line.productId,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
        },
      ],
    })
  expect(replaced.status).toBe(200)
  const sent = await context()
    .request.post(`/api/orders/${orderId}/send`)
    .set(USER_ID_HEADER, String(context().seed.providerUserId))
  expect(sent.status).toBe(200)
  return expectProviderDetail(sent.body)
}

function requireSplit(
  detail: ProviderOrderDetailDto,
): NonNullable<ProviderOrderDetailDto['split']> {
  if (detail.split === null) {
    throw new Error('expected a server split')
  }
  return detail.split
}

function orderIds(orders: readonly { id: number }[]): number[] {
  return orders.map((order) => order.id).sort((left, right) => left - right)
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

describe('personas and users', () => {
  it('lists seeded users and gives each exactly one role', async () => {
    const users = await listUsers()
    expect(users.length).toBeGreaterThanOrEqual(4)
    users.forEach((user) => {
      if (user.role === 'provider') {
        expect(user.providerId).not.toBeNull()
        expect(user.patientId).toBeNull()
        return
      }
      expect(user.role).toBe('patient')
      expect(user.patientId).not.toBeNull()
      expect(user.providerId).toBeNull()
    })

    const provider = users.find(
      (user) => user.id === context().seed.providerUserId,
    )
    const otherProvider = users.find(
      (user) => user.id === context().seed.otherProviderUserId,
    )
    const patient = users.find(
      (user) => user.id === context().seed.patientUserId,
    )
    const otherPatient = users.find(
      (user) => user.id === context().seed.otherPatientUserId,
    )
    expect(provider?.role).toBe('provider')
    expect(otherProvider?.role).toBe('provider')
    expect(provider?.providerId).not.toBe(otherProvider?.providerId)
    expect(patient?.role).toBe('patient')
    expect(patient?.patientId).toBe(context().seed.patientId)
    expect(otherPatient?.role).toBe('patient')
    expect(otherPatient?.patientId).not.toBe(context().seed.patientId)
    expect(otherPatient?.patientId).not.toBeNull()
    expect(users.some((user) => user.role === 'provider')).toBe(true)
    expect(users.some((user) => user.role === 'patient')).toBe(true)
  })

  it('rejects a missing or unknown X-User-Id', async () => {
    const missing = await context().request.get('/api/orders')
    expectError(missing, 401, 'UNAUTHENTICATED')

    const users = await listUsers()
    const unknownId =
      users.reduce((highest, user) => Math.max(highest, user.id), 0) + 1
    const unknown = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(unknownId))
    expectError(unknown, 401, 'UNAUTHENTICATED')
  })

  it('forbids a patient from creating an order', async () => {
    const before = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(before.status).toBe(200)
    const beforeIds = orderIds(expectProviderSummaries(before.body))

    const created = await context()
      .request.post('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
      .send({ patientId: context().seed.patientId })
    expectError(created, 403, 'FORBIDDEN')

    const after = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(after.status).toBe(200)
    expect(orderIds(expectProviderSummaries(after.body))).toEqual(beforeIds)
  })

  it('forbids the provider from paying', async () => {
    const draft = await createDraft()
    const pending = await sendDraft(draft.id)
    const productsBefore = await context()
      .request.get('/api/products')
      .query({ limit: 100 })
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(productsBefore.status).toBe(200)
    const stockBefore = z
      .array(productDtoSchema)
      .parse(asRecord(productsBefore.body).items)
      .map((product) => ({
        id: product.id,
        stockQuantity: product.stockQuantity,
      }))
      .sort((left, right) => left.id - right.id)

    const paid = await context()
      .request.post(`/api/orders/${pending.id}/pay`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
      .send({})
    expectError(paid, 403, 'FORBIDDEN')

    const current = await context()
      .request.get(`/api/orders/${pending.id}`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(current.status).toBe(200)
    const detail = expectProviderDetail(current.body)
    expect(detail.status).toBe('pending_payment')
    expect(detail.payment).toBeNull()
    expect(detail.ledger).toEqual([])
    const productsAfter = await context()
      .request.get('/api/products')
      .query({ limit: 100 })
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(productsAfter.status).toBe(200)
    const stockAfter = z
      .array(productDtoSchema)
      .parse(asRecord(productsAfter.body).items)
      .map((product) => ({
        id: product.id,
        stockQuantity: product.stockQuantity,
      }))
      .sort((left, right) => left.id - right.id)
    expect(stockAfter).toEqual(stockBefore)
  })

  it('hides a draft from the patient until it is sent', async () => {
    const draft = await createDraft()
    const hiddenList = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(hiddenList.status).toBe(200)
    const hidden = expectPatientSummaries(hiddenList.body)
    expect(hidden.map((order) => order.id)).not.toContain(draft.id)
    expect(hidden.every((order) => order.status !== 'draft')).toBe(true)

    const hiddenDetail = await context()
      .request.get(`/api/orders/${draft.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expectError(hiddenDetail, 404, 'NOT_FOUND')

    const sent = await sendDraft(draft.id)
    const split = requireSplit(sent)
    const visibleList = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(visibleList.status).toBe(200)
    const visible = expectPatientSummaries(visibleList.body)
    const summary = visible.find((order) => order.id === sent.id)
    expect(summary?.status).toBe('pending_payment')
    expect(summary?.totalCents).toBe(split.totalCents)
    expect(split.totalCents).toBe(split.subtotalCents)

    const visibleDetail = await context()
      .request.get(`/api/orders/${sent.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(visibleDetail.status).toBe(200)
    const patientOrder = expectPatientDetail(visibleDetail.body)
    expect(patientOrder.status).toBe('pending_payment')
    expect(patientOrder.payment).toBeNull()
    expect(patientOrder.totalCents).toBe(split.totalCents)
    expect(patientOrder.createdAt).toMatch(ISO_TIMESTAMP)
  })

  it('forbids another provider from reading the order', async () => {
    const draft = await createDraft()
    const sent = await sendDraft(draft.id)
    const foreign = await context()
      .request.get(`/api/orders/${sent.id}`)
      .set(USER_ID_HEADER, String(context().seed.otherProviderUserId))
    expectError(foreign, 403, 'FORBIDDEN')

    const owner = await context()
      .request.get(`/api/orders/${sent.id}`)
      .set(USER_ID_HEADER, String(context().seed.providerUserId))
    expect(owner.status).toBe(200)
    expect(expectProviderDetail(owner.body).id).toBe(sent.id)
  })

  it('forbids another patient from reading or listing the order', async () => {
    const draft = await createDraft()
    const sent = await sendDraft(draft.id)
    const foreignList = await context()
      .request.get('/api/orders')
      .set(USER_ID_HEADER, String(context().seed.otherPatientUserId))
    expect(foreignList.status).toBe(200)
    const foreignOrders = expectPatientSummaries(foreignList.body)
    expect(foreignOrders.map((order) => order.id)).not.toContain(sent.id)

    const foreign = await context()
      .request.get(`/api/orders/${sent.id}`)
      .set(USER_ID_HEADER, String(context().seed.otherPatientUserId))
    expectError(foreign, 403, 'FORBIDDEN')

    const owner = await context()
      .request.get(`/api/orders/${sent.id}`)
      .set(USER_ID_HEADER, String(context().seed.patientUserId))
    expect(owner.status).toBe(200)
    expect(expectPatientDetail(owner.body).id).toBe(sent.id)
  })
})
