import {
  computeSplit,
  markupBpsFromPrice,
  minUnitPriceCents,
  SplitValidationError,
  type OrderStatusSelection,
  type ProviderOrderListItemDto,
  type ProviderOrderListPageDto,
  type LedgerEntryDto,
  type OrderLineDto,
  type OrderSplitDto,
  type PatientOrderDetailDto,
  type PatientOrderSummaryDto,
  type PaymentDto,
  type ProviderOrderDetailDto,
  type ProviderOrderLineDto,
  type ProviderOrderSummaryDto,
} from '@supplement-orders/domain'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '../db/client'
import type { ReadHooks } from '../server'
import { forbidden, notFound } from '../http/errors'
import type { CurrentUser } from '../seams'

/** A database handle or a transaction: anything the read helpers can query through. */
type Reader = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Runs `read` in one read-only REPEATABLE READ transaction, so every query in it
 * sees the same snapshot (revision 11, N5): an order's header, lines, payment and
 * ledger can never come from different moments.
 */
function inSnapshot<T>(db: Db, read: (tx: Reader) => Promise<T>): Promise<T> {
  return db.transaction(read, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  })
}
import {
  ledgerEntries,
  orderItems,
  orders,
  patients,
  payments,
  products,
  providers,
  users,
} from '../db/schema'

export type OrderView = 'provider' | 'patient'

const patientUsers = alias(users, 'patient_users')
const providerUsers = alias(users, 'provider_users')

function iso(date: Date | null) {
  return date === null ? null : date.toISOString()
}

async function selectOrders(db: Reader, where: SQL | undefined) {
  return db
    .select({
      id: orders.id,
      status: orders.status,
      patientId: orders.patientId,
      patientName: patientUsers.name,
      patientAddress: patients.address,
      patientDateOfBirth: patients.dateOfBirth,
      providerId: orders.providerId,
      providerName: providerUsers.name,
      subtotalCents: orders.subtotalCents,
      platformFeeCents: orders.platformFeeCents,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      sentAt: orders.sentAt,
      paidAt: orders.paidAt,
      cancelledAt: orders.cancelledAt,
      revision: orders.revision,
    })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(patientUsers, eq(patientUsers.id, patients.userId))
    .innerJoin(providers, eq(providers.id, orders.providerId))
    .innerJoin(providerUsers, eq(providerUsers.id, providers.userId))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
}

type OrderRow = Awaited<ReturnType<typeof selectOrders>>[number]

async function selectLines(db: Reader, orderIds: number[]) {
  if (orderIds.length === 0) return []
  return db
    .select({
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      productName: products.name,
      sku: products.sku,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
      unitCogsCents: orderItems.unitCogsCents,
      stockQuantity: products.stockQuantity,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.id))
}

type LineRow = Awaited<ReturnType<typeof selectLines>>[number]

/**
 * Sent orders report the split snapshotted on send. Drafts are priced live, and
 * get no split while they would fail send validation (no lines, an incomplete
 * line, or a price below its minimum): the server never reports a split it
 * would refuse to charge.
 */
function splitFor(order: OrderRow, lines: LineRow[]): OrderSplitDto | null {
  if (
    order.subtotalCents !== null &&
    order.platformFeeCents !== null &&
    order.totalCents !== null
  ) {
    const cogsCents = lines.reduce(
      (sum, l) => sum + l.quantity * (l.unitCogsCents ?? 0),
      0,
    )
    return {
      subtotalCents: order.subtotalCents,
      platformFeeCents: order.platformFeeCents,
      totalCents: order.totalCents,
      cogsCents,
      providerMarginCents:
        order.subtotalCents - cogsCents - order.platformFeeCents,
    }
  }
  const complete = lines.flatMap(
    ({ quantity, unitPriceCents, unitCogsCents }) =>
      unitPriceCents === null || unitCogsCents === null
        ? []
        : [{ quantity, unitPriceCents, unitCogsCents }],
  )
  if (complete.length === 0 || complete.length !== lines.length) return null
  try {
    return computeSplit(complete)
  } catch (err) {
    if (err instanceof SplitValidationError) return null
    throw err
  }
}

function summaryBase(order: OrderRow) {
  return {
    id: order.id,
    status: order.status,
    patientId: order.patientId,
    patientName: order.patientName,
    providerId: order.providerId,
    providerName: order.providerName,
    createdAt: order.createdAt.toISOString(),
    sentAt: iso(order.sentAt),
    paidAt: iso(order.paidAt),
    cancelledAt: iso(order.cancelledAt),
    revision: order.revision,
  }
}

function providerSummary(
  order: OrderRow,
  lines: LineRow[],
): ProviderOrderSummaryDto {
  return {
    ...summaryBase(order),
    view: 'provider',
    split: splitFor(order, lines),
  }
}

/** Patients only ever see sent orders, which always carry a stored total. */
function patientSummary(order: OrderRow): PatientOrderSummaryDto {
  if (order.totalCents === null) {
    throw new Error(
      `Order ${order.id} has no total but is visible to its patient`,
    )
  }
  return {
    ...summaryBase(order),
    view: 'patient',
    totalCents: order.totalCents,
  }
}

/**
 * A derived value, or null when it can't be computed exactly (M3): a draft saved
 * before revision 9's bounds may hold amounts whose markup or extension is not a
 * safe integer, and it must still load rather than fail with a 500.
 */
function derived(compute: () => number | null): number | null {
  try {
    const value = compute()
    return value === null || Number.isSafeInteger(value) ? value : null
  } catch (err) {
    if (err instanceof SplitValidationError) return null
    throw err
  }
}

function providerLine(l: LineRow): ProviderOrderLineDto {
  const { unitCogsCents, unitPriceCents } = l
  return {
    productId: l.productId,
    productName: l.productName,
    sku: l.sku,
    quantity: l.quantity,
    unitPriceCents,
    lineTotalCents:
      unitPriceCents === null
        ? null
        : derived(() => l.quantity * unitPriceCents),
    unitCogsCents,
    markupBps:
      unitCogsCents === null || unitPriceCents === null
        ? null
        : derived(() => markupBpsFromPrice(unitCogsCents, unitPriceCents)),
    stockQuantity: l.stockQuantity,
    minUnitPriceCents:
      unitCogsCents === null
        ? null
        : derived(() => minUnitPriceCents(unitCogsCents)),
  }
}

function patientLine(l: LineRow): OrderLineDto {
  if (
    l.productId === null ||
    l.productName === null ||
    l.sku === null ||
    l.unitPriceCents === null
  ) {
    throw new Error(
      `Order ${l.orderId} has an incomplete line but is not a draft`,
    )
  }
  return {
    productId: l.productId,
    productName: l.productName,
    sku: l.sku,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    lineTotalCents: l.quantity * l.unitPriceCents,
  }
}

function groupLines(lines: LineRow[]) {
  return lines.reduce((acc, line) => {
    acc.set(line.orderId, [...(acc.get(line.orderId) ?? []), line])
    return acc
  }, new Map<number, LineRow[]>())
}

export async function listProviderOrders(
  db: Db,
  providerId: number,
  patientId?: number,
) {
  const rows = await selectOrders(
    db,
    and(
      eq(orders.providerId, providerId),
      patientId === undefined ? undefined : eq(orders.patientId, patientId),
    ),
  )
  const lines = groupLines(
    await selectLines(
      db,
      rows.map((o) => o.id),
    ),
  )
  return rows.map((o) => providerSummary(o, lines.get(o.id) ?? []))
}

/** Patients see only orders they were sent: never drafts or drafts cancelled unsent. */
export async function listPatientOrders(db: Db, patientId: number) {
  const rows = await selectOrders(
    db,
    and(
      eq(orders.patientId, patientId),
      ne(orders.status, 'draft'),
      isNotNull(orders.sentAt),
    ),
  )
  return rows.map(patientSummary)
}

/** Ownership-check columns for an order, or undefined if it does not exist. */
export async function findOrderOwnership(db: Reader, orderId: number) {
  const [row] = await db
    .select({
      id: orders.id,
      providerId: orders.providerId,
      patientId: orders.patientId,
      status: orders.status,
      sentAt: orders.sentAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
  return row
}

async function loadPayment(db: Reader, orderId: number) {
  const [row] = await db
    .select({
      id: payments.id,
      amountCents: payments.amountCents,
      reference: payments.gatewayReference,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.orderId, orderId))
  if (!row) return null
  const payment: PaymentDto = { ...row, createdAt: row.createdAt.toISOString() }
  return payment
}

async function loadOne(db: Reader, orderId: number, hooks: ReadHooks = {}) {
  const [order] = await selectOrders(db, eq(orders.id, orderId))
  if (!order) throw new Error(`Order ${orderId} disappeared`)
  await hooks.afterOrderHeader?.()
  const lines = await selectLines(db, [orderId])
  return { order, lines, payment: await loadPayment(db, orderId) }
}

async function readProviderOrderDetail(
  db: Reader,
  orderId: number,
  hooks?: ReadHooks,
): Promise<ProviderOrderDetailDto> {
  const { order, lines, payment } = await loadOne(db, orderId, hooks)
  const ledgerRows = await db
    .select({
      id: ledgerEntries.id,
      type: ledgerEntries.type,
      amountCents: ledgerEntries.amountCents,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.orderId, orderId))
    .orderBy(asc(ledgerEntries.id))
  const ledger: LedgerEntryDto[] = ledgerRows.map((e) => ({
    ...e,
    createdAt: e.createdAt.toISOString(),
  }))
  return {
    ...providerSummary(order, lines),
    patientDateOfBirth: order.patientDateOfBirth,
    patientAddress: order.patientAddress,
    lines: lines.map(providerLine),
    payment,
    ledger,
  }
}

async function readPatientOrderDetail(
  db: Reader,
  orderId: number,
  hooks?: ReadHooks,
): Promise<PatientOrderDetailDto> {
  const { order, lines, payment } = await loadOne(db, orderId, hooks)
  return {
    ...patientSummary(order),
    patientAddress: order.patientAddress,
    lines: lines.map(patientLine),
    payment,
  }
}

/** The provider's view of an order, read in one snapshot. */
export function loadProviderOrderDetail(
  db: Db,
  orderId: number,
  hooks?: ReadHooks,
): Promise<ProviderOrderDetailDto> {
  return inSnapshot(db, (tx) => readProviderOrderDetail(tx, orderId, hooks))
}

/** The patient's view of an order, read in one snapshot. */
export function loadPatientOrderDetail(
  db: Db,
  orderId: number,
  hooks?: ReadHooks,
): Promise<PatientOrderDetailDto> {
  return inSnapshot(db, (tx) => readPatientOrderDetail(tx, orderId, hooks))
}

/**
 * GET /api/orders/:id: the visibility decision and the whole detail come from
 * one snapshot (revision 11, N5). A read overlapping a provider's cancel,
 * reopen and edit therefore returns the coherent old sent order or a 404 to
 * the patient, never lines from a newer, unsent draft.
 * 404 if missing (or unsent, for its patient); 403 if not the caller's.
 */
export function loadOrderDetailFor(
  db: Db,
  user: CurrentUser,
  orderId: number,
  hooks?: ReadHooks,
): Promise<ProviderOrderDetailDto | PatientOrderDetailDto> {
  return inSnapshot(db, async (tx) => {
    const order = await findOrderOwnership(tx, orderId)
    if (!order) throw notFound('Order')
    if (user.role === 'provider') {
      if (order.providerId !== user.providerId) throw forbidden()
      return readProviderOrderDetail(tx, orderId, hooks)
    }
    if (order.patientId !== user.patientId) throw forbidden()
    // Unsent orders (drafts, and drafts cancelled before sending) stay hidden.
    if (order.sentAt === null) throw notFound('Order')
    return readPatientOrderDetail(tx, orderId, hooks)
  })
}

/**
 * The most relevant date for an order's state: when it was paid or cancelled,
 * else sent, else created. Only one of paidAt/cancelledAt is ever set, and each
 * is later than sentAt, so this equals the latest activity. Mirrors the
 * expression index orders_provider_status_activity_idx (migration 0006).
 */
export const orderActivityAt = sql<Date>`coalesce(${orders.paidAt}, ${orders.cancelledAt}, ${orders.sentAt}, ${orders.createdAt})`

/**
 * Provider order list (Orders tab, dashboard Awaiting payment). Exactly
 * [pending_payment] lists the oldest sent first, served by (provider_id, status,
 * sent_at, id). Any other selection, `all` included, lists the most recent
 * activity first: one status uses orders_provider_status_activity_idx, several
 * (status IN ...) or all walk orders_provider_activity_idx in order and filter.
 */
export async function listProviderOrderPage(
  db: Db,
  providerId: number,
  {
    status,
    patientId,
    offset,
    limit,
  }: {
    status: OrderStatusSelection
    patientId?: number
    offset: number
    limit: number
  },
): Promise<ProviderOrderListPageDto> {
  const where = and(
    eq(orders.providerId, providerId),
    status === 'all' ? undefined : inArray(orders.status, status),
    patientId === undefined ? undefined : eq(orders.patientId, patientId),
  )
  const awaitingOnly =
    status !== 'all' && status.length === 1 && status[0] === 'pending_payment'
  const ordering = awaitingOnly
    ? [asc(orders.sentAt), asc(orders.id)]
    : [desc(orderActivityAt), desc(orders.id)]
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        id: orders.id,
        patientId: orders.patientId,
        patientName: patientUsers.name,
        patientDateOfBirth: patients.dateOfBirth,
        status: orders.status,
        totalCents: orders.totalCents,
        createdAt: orders.createdAt,
        sentAt: orders.sentAt,
        paidAt: orders.paidAt,
        cancelledAt: orders.cancelledAt,
      })
      .from(orders)
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .innerJoin(patientUsers, eq(patientUsers.id, patients.userId))
      .where(where)
      .orderBy(...ordering)
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(orders).where(where),
  ])
  const items = rows.map((row): ProviderOrderListItemDto => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    sentAt: iso(row.sentAt),
    paidAt: iso(row.paidAt),
    cancelledAt: iso(row.cancelledAt),
  }))
  return { items, total: counted?.total ?? 0, offset, limit }
}
