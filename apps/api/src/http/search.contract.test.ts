import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  USER_ID_HEADER,
  apiErrorResponseSchema,
  patientPageDtoSchema,
  productPageDtoSchema,
  userDtoSchema,
} from '@supplement-orders/domain'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  PatientDto,
  PatientPageDto,
  ProductDto,
  ProductPageDto,
  UserDto,
} from '@supplement-orders/domain'
import { createTestContext } from '../testing/harness'
import type { TestContext } from '../testing/harness'

// Black-box HTTP contract for revision 3 list search and offset pages.
// The harness seed is small, so the default page is the whole ordered list.
// Match sets are derived from that list. `%` and `_` are literal characters.

const PAGE_KEYS = ['items', 'total', 'offset', 'limit']

const PRODUCT_KEYS = ['id', 'sku', 'name', 'cogsCents', 'stockQuantity']

const PATIENT_KEYS = [
  'id',
  'userId',
  'providerId',
  'name',
  'address',
  'orderCount',
  'latestOrderStatus',
]

interface ContextHolder {
  ctx?: TestContext
}

interface HttpResult {
  status: number
  body: unknown
}

interface ListParams {
  q?: string
  offset?: string
  limit?: string
}

interface NamedId {
  id: number
  name: string
}

const holder: ContextHolder = {}

function context(): TestContext {
  if (!holder.ctx) {
    throw new Error('test context was not created')
  }
  return holder.ctx
}

function providerUser(): string {
  return String(context().seed.providerUserId)
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

function definedQuery(params: ListParams): Record<string, string> {
  const entries = Object.entries(params).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, value]],
  )
  return Object.fromEntries(entries)
}

async function getRaw(
  path: string,
  params: ListParams,
  userId: string,
): Promise<HttpResult> {
  const response = await context()
    .request.get(path)
    .set(USER_ID_HEADER, userId)
    .query(definedQuery(params))
  return { status: response.status, body: response.body }
}

function expectProductPage(body: unknown): ProductPageDto {
  expectExactKeys(body, PAGE_KEYS)
  const record = asRecord(body)
  if (!Array.isArray(record.items)) {
    throw new Error('items must be an array')
  }
  record.items.forEach((item) => {
    expectExactKeys(item, PRODUCT_KEYS)
  })
  return productPageDtoSchema.parse(body)
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

async function getProducts(
  params: ListParams,
  userId = providerUser(),
): Promise<ProductPageDto> {
  const response = await getRaw('/api/products', params, userId)
  expect(response.status).toBe(200)
  return expectProductPage(response.body)
}

async function getPatients(
  params: ListParams,
  userId = providerUser(),
): Promise<PatientPageDto> {
  const response = await getRaw('/api/patients', params, userId)
  expect(response.status).toBe(200)
  return expectPatientPage(response.body)
}

function fold(value: string): string {
  return value.toLocaleLowerCase()
}

function contains(haystack: string, needle: string): boolean {
  return fold(haystack).includes(fold(needle))
}

function letterTokens(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 3)
}

function tokenMissingFrom(
  source: string,
  blocked: readonly string[],
): string | undefined {
  const blocks = blocked.map(fold)
  return letterTokens(source).find((token) =>
    blocks.every((block) => !block.includes(token)),
  )
}

function requireToken(token: string | undefined, message: string): string {
  if (!token) {
    throw new Error(message)
  }
  return token
}

function windows(value: string, size: number): string[] {
  const folded = fold(value)
  return [...folded]
    .map((_, index) => folded.slice(index, index + size))
    .filter((window) => window.length === size && /^[a-z0-9]+$/.test(window))
}

function sharedPiece(
  values: readonly string[],
  size: number,
): string | undefined {
  const folded = values.map(fold)
  const pieces =
    size >= 3
      ? folded.flatMap((value) => letterTokens(value))
      : folded.flatMap((value) => windows(value, size))
  return pieces.find(
    (piece) => folded.filter((value) => value.includes(piece)).length >= 2,
  )
}

function requireShared(values: readonly string[], label: string): string {
  return requireToken(
    sharedPiece(values, 3) ?? sharedPiece(values, 2),
    `${label} seed has no shared search substring`,
  )
}

function expectNameThenId(items: readonly NamedId[]): void {
  const ordered = [...items].sort((left, right) => {
    if (left.name < right.name) {
      return -1
    }
    if (left.name > right.name) {
      return 1
    }
    return left.id - right.id
  })
  expect(items.map((item) => item.id)).toEqual(ordered.map((item) => item.id))
}

function productMatches(product: ProductDto, q: string): boolean {
  return contains(product.name, q) || contains(product.sku, q)
}

function patientMatches(patient: PatientDto, q: string): boolean {
  return contains(patient.name, q) || contains(patient.address, q)
}

function productNameQuery(products: readonly ProductDto[]): string {
  const match = products
    .map((product) =>
      tokenMissingFrom(product.name, [
        ...products
          .filter((other) => other.id !== product.id)
          .map((other) => other.name),
        ...products.map((other) => other.sku),
      ]),
    )
    .find((token) => token !== undefined)
  return requireToken(match, 'seed products have no name-only search token')
}

function productSkuQuery(products: readonly ProductDto[]): string {
  const match = products
    .map((product) =>
      tokenMissingFrom(product.sku, [
        ...products.map((other) => other.name),
        ...products
          .filter((other) => other.id !== product.id)
          .map((other) => other.sku),
      ]),
    )
    .find((token) => token !== undefined)
  return requireToken(match, 'seed products have no SKU-only search token')
}

function patientNameQuery(patients: readonly PatientDto[]): string {
  const match = patients
    .map((patient) =>
      tokenMissingFrom(patient.name, [
        ...patients
          .filter((other) => other.id !== patient.id)
          .flatMap((other) => [other.name, other.address]),
        patient.address,
      ]),
    )
    .find((token) => token !== undefined)
  return requireToken(match, 'seed patients have no name-only search token')
}

function patientAddressQuery(patients: readonly PatientDto[]): string {
  const match = patients
    .map((patient) =>
      tokenMissingFrom(patient.address, [
        ...patients.map((other) => other.name),
        ...patients
          .filter((other) => other.id !== patient.id)
          .map((other) => other.address),
      ]),
    )
    .find((token) => token !== undefined)
  return requireToken(match, 'seed patients have no address-only search token')
}

async function completeProducts(): Promise<ProductDto[]> {
  const page = await getProducts({})
  expect(page.offset).toBe(0)
  expect(page.limit).toBe(25)
  expect(page.total).toBe(page.items.length)
  expect(page.total).toBeGreaterThanOrEqual(4)
  expect(new Set(page.items.map((item) => item.id)).size).toBe(
    page.items.length,
  )
  expectNameThenId(page.items)
  return page.items
}

async function completePatients(
  userId = providerUser(),
): Promise<PatientDto[]> {
  const page = await getPatients({}, userId)
  expect(page.offset).toBe(0)
  expect(page.limit).toBe(25)
  expect(page.total).toBe(page.items.length)
  expect(page.total).toBeGreaterThanOrEqual(2)
  expect(new Set(page.items.map((item) => item.id)).size).toBe(
    page.items.length,
  )
  expectNameThenId(page.items)
  return page.items
}

async function expectQueryMatches<T extends { id: number }>(
  load: (params: ListParams) => Promise<{
    items: T[]
    total: number
    offset: number
    limit: number
  }>,
  rows: readonly T[],
  q: string,
  matches: (row: T, query: string) => boolean,
): Promise<void> {
  const expected = rows.filter((row) => matches(row, q))
  expect(expected.length).toBeGreaterThan(0)
  const page = await load({ q, limit: '100' })
  const upper = await load({ q: q.toUpperCase(), limit: '100' })
  expect(q).not.toBe(q.toUpperCase())
  expect(page.total).toBe(expected.length)
  expect(page.offset).toBe(0)
  expect(page.limit).toBe(100)
  expect(page.items.map((item) => item.id)).toEqual(
    expected.map((item) => item.id),
  )
  expect(upper.items.map((item) => item.id)).toEqual(
    expected.map((item) => item.id),
  )
  expect(upper.total).toBe(expected.length)
}

async function expectLiteral<T extends { id: number }>(
  load: (params: ListParams) => Promise<{ items: T[]; total: number }>,
  rows: readonly T[],
  q: '%' | '_',
  matches: (row: T, query: string) => boolean,
): Promise<void> {
  const expected = rows.filter((row) => matches(row, q))
  const page = await load({ q, limit: '100' })
  expect(page.total).toBe(expected.length)
  expect(page.items.map((item) => item.id)).toEqual(
    expected.map((item) => item.id),
  )
  if (expected.length !== rows.length) {
    expect(page.total).not.toBe(rows.length)
  }
}

async function expectStablePages<T extends { id: number }>(
  load: (params: ListParams) => Promise<{
    items: T[]
    total: number
    offset: number
    limit: number
  }>,
  rows: readonly T[],
  limit: number,
): Promise<void> {
  const width = limit * 2
  expect(rows.length).toBeGreaterThanOrEqual(width)
  const first = await load({ offset: '0', limit: String(limit) })
  const second = await load({ offset: String(limit), limit: String(limit) })
  const overlap = first.items.filter((item) =>
    second.items.some((other) => other.id === item.id),
  )
  expect(overlap).toEqual([])
  expect([...first.items, ...second.items]).toEqual(rows.slice(0, width))
  expect(first.total).toBe(rows.length)
  expect(second.total).toBe(rows.length)
  expect(first.offset).toBe(0)
  expect(second.offset).toBe(limit)
  expect(first.limit).toBe(limit)
  expect(second.limit).toBe(limit)
}

async function expectInvalidPages(path: string): Promise<void> {
  const userId = providerUser()
  expectError(
    await getRaw(path, { limit: '101' }, userId),
    400,
    'VALIDATION_ERROR',
    'limit',
  )
  expectError(
    await getRaw(path, { offset: '-1' }, userId),
    400,
    'VALIDATION_ERROR',
    'offset',
  )
  expectError(
    await getRaw(path, { limit: '1.5' }, userId),
    400,
    'VALIDATION_ERROR',
    'limit',
  )
}

async function listUsers(): Promise<UserDto[]> {
  const response = await context().request.get('/api/users')
  expect(response.status).toBe(200)
  return z.array(userDtoSchema).parse(response.body)
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

describe('GET /api/products', () => {
  it('defaults to a page of 25 ordered by name then id', async () => {
    const products = await completeProducts()
    const wide = await getProducts({ limit: '100' })
    expect(wide.limit).toBe(100)
    expect(wide.offset).toBe(0)
    expect(wide.total).toBe(products.length)
    expect(wide.items).toEqual(products)
  })

  it('rejects a limit over 100, a negative offset, and a non-integer limit', async () => {
    await expectInvalidPages('/api/products')
  })

  it('matches name or SKU, ignoring case', async () => {
    const products = await completeProducts()
    const nameQuery = productNameQuery(products)
    const skuQuery = productSkuQuery(products)
    const nameMatches = products.filter((product) =>
      productMatches(product, nameQuery),
    )
    const skuMatches = products.filter((product) =>
      productMatches(product, skuQuery),
    )

    expect(
      nameMatches.every((product) => contains(product.name, nameQuery)),
    ).toBe(true)
    expect(
      nameMatches.some((product) => contains(product.sku, nameQuery)),
    ).toBe(false)
    expect(skuMatches.every((product) => contains(product.sku, skuQuery))).toBe(
      true,
    )
    expect(skuMatches.some((product) => contains(product.name, skuQuery))).toBe(
      false,
    )
    await expectQueryMatches(getProducts, products, nameQuery, productMatches)
    await expectQueryMatches(getProducts, products, skuQuery, productMatches)
  })

  it('treats % and _ as literal characters', async () => {
    const products = await completeProducts()
    await expectLiteral(getProducts, products, '%', productMatches)
    await expectLiteral(getProducts, products, '_', productMatches)
  })

  it('pages stably and counts every match, including past the last row', async () => {
    const products = await completeProducts()
    await expectStablePages(getProducts, products, 2)

    const q = requireShared(
      products.map((product) => `${product.name} ${product.sku}`),
      'product',
    )
    const expected = products.filter((product) => productMatches(product, q))
    expect(expected.length).toBeGreaterThan(1)
    const page = await getProducts({ q, offset: '0', limit: '1' })
    expect(page.items).toEqual(expected.slice(0, 1))
    expect(page.total).toBe(expected.length)
    expect(page.offset).toBe(0)
    expect(page.limit).toBe(1)

    const past = await getProducts({
      offset: String(products.length),
      limit: '2',
    })
    expect(past.items).toEqual([])
    expect(past.total).toBe(products.length)
    expect(past.offset).toBe(products.length)
    expect(past.limit).toBe(2)
  })
})

describe('GET /api/patients', () => {
  it('defaults to the signed-in provider page of 25, ordered by name then id', async () => {
    const patients = await completePatients()
    const providerIds = new Set(patients.map((patient) => patient.providerId))
    expect(providerIds.size).toBe(1)
    expect(patients.every((patient) => patient.orderCount === 0)).toBe(true)
    expect(
      patients.every((patient) => patient.latestOrderStatus === null),
    ).toBe(true)
    const wide = await getPatients({ limit: '100' })
    expect(wide.limit).toBe(100)
    expect(wide.total).toBe(patients.length)
    expect(wide.items).toEqual(patients)
  })

  it('rejects a limit over 100, a negative offset, and a non-integer limit', async () => {
    await expectInvalidPages('/api/patients')
  })

  it('matches name or address, ignoring case', async () => {
    const patients = await completePatients()
    const nameQuery = patientNameQuery(patients)
    const addressQuery = patientAddressQuery(patients)
    const nameMatches = patients.filter((patient) =>
      patientMatches(patient, nameQuery),
    )
    const addressMatches = patients.filter((patient) =>
      patientMatches(patient, addressQuery),
    )

    expect(
      nameMatches.every((patient) => contains(patient.name, nameQuery)),
    ).toBe(true)
    expect(
      nameMatches.some((patient) => contains(patient.address, nameQuery)),
    ).toBe(false)
    expect(
      addressMatches.every((patient) =>
        contains(patient.address, addressQuery),
      ),
    ).toBe(true)
    expect(
      addressMatches.some((patient) => contains(patient.name, addressQuery)),
    ).toBe(false)
    await expectQueryMatches(getPatients, patients, nameQuery, patientMatches)
    await expectQueryMatches(
      getPatients,
      patients,
      addressQuery,
      patientMatches,
    )
  })

  it('treats % and _ as literal characters', async () => {
    const patients = await completePatients()
    await expectLiteral(getPatients, patients, '%', patientMatches)
    await expectLiteral(getPatients, patients, '_', patientMatches)
  })

  it('pages stably and counts every match, including past the last row', async () => {
    // The harness seed has two patients for this provider, so a two-row page
    // is the whole list. One-row pages are what prove the order is stable.
    const patients = await completePatients()
    await expectStablePages(getPatients, patients, 1)

    const q = requireShared(
      patients.map((patient) => `${patient.name} ${patient.address}`),
      'patient',
    )
    const expected = patients.filter((patient) => patientMatches(patient, q))
    expect(expected.length).toBeGreaterThan(1)
    const page = await getPatients({ q, offset: '0', limit: '1' })
    expect(page.items).toEqual(expected.slice(0, 1))
    expect(page.total).toBe(expected.length)
    expect(page.limit).toBe(1)

    const past = await getPatients({
      offset: String(patients.length),
      limit: '2',
    })
    expect(past.items).toEqual([])
    expect(past.total).toBe(patients.length)
    expect(past.offset).toBe(patients.length)
    expect(past.limit).toBe(2)
  })

  it('counts orders and reports the latest status', async () => {
    const before = await completePatients()
    const patientId = context().seed.patientId
    expect(before.some((patient) => patient.id === patientId)).toBe(true)
    const created = await context()
      .request.post('/api/orders')
      .set(USER_ID_HEADER, providerUser())
      .send({ patientId })
    expect(created.status).toBe(201)

    const after = await completePatients()
    const updated = after.find((patient) => patient.id === patientId)
    expect(updated?.orderCount).toBe(1)
    expect(updated?.latestOrderStatus).toBe('draft')
    after
      .filter((patient) => patient.id !== patientId)
      .forEach((patient) => {
        expect(patient.orderCount).toBe(0)
        expect(patient.latestOrderStatus).toBeNull()
      })
  })

  it("omits another provider's patients even when the query is their name", async () => {
    const own = await completePatients()
    const foreign = await completePatients(
      String(context().seed.otherProviderUserId),
    )
    const foreignIds = new Set(foreign.map((patient) => patient.id))
    expect(own.some((patient) => foreignIds.has(patient.id))).toBe(false)
    expect(own[0]?.providerId).not.toBe(foreign[0]?.providerId)

    const named = foreign[0]
    if (!named) {
      throw new Error('other provider has no patients')
    }
    const searched = await getPatients({ q: named.name, limit: '100' })
    expect(searched.items.some((patient) => patient.id === named.id)).toBe(
      false,
    )
    expect(searched.items.map((patient) => patient.id)).toEqual(
      own
        .filter((patient) => patientMatches(patient, named.name))
        .map((patient) => patient.id),
    )
    expect(searched.total).toBe(searched.items.length)
  })
})

describe('list access', () => {
  it('rejects an unknown X-User-Id', async () => {
    const users = await listUsers()
    const unknownId = String(
      users.reduce((highest, user) => Math.max(highest, user.id), 0) + 1,
    )
    expectError(
      await getRaw('/api/products', {}, unknownId),
      401,
      'UNAUTHENTICATED',
    )
    expectError(
      await getRaw('/api/patients', {}, unknownId),
      401,
      'UNAUTHENTICATED',
    )
  })

  it('forbids a patient from listing patients', async () => {
    const response = await getRaw(
      '/api/patients',
      {},
      String(context().seed.patientUserId),
    )
    expectError(response, 403, 'FORBIDDEN')
  })
})
