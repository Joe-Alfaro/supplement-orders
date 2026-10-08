import {
  computeSplit,
  markupBpsFromPrice,
  minUnitPriceCents,
  partialPaymentQuoteDto,
  planPartialPayment,
  SplitValidationError,
  STORED_ORDER_STATUSES,
  type OrderStatus,
  type PartialPaymentQuoteDto,
  type PaymentInProgressDto,
  type OrderStatusSelection,
  type ProviderOrderListItemDto,
  type ProviderOrderListPageDto,
  type JournalSplit,
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
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '../db/client'
import type { ReadHooks } from '../server'
import { notFound } from '../http/errors'
import { selectJournalSplits, selectOrderJournal } from '../ledger/journals'
import type { CurrentUser } from '../seams'

/** A database handle or a transaction: anything the read helpers can query through. */
type Reader = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Runs `read` in one read-only REPEATABLE READ transaction, so every query in it
 * sees the same snapshot (revision 11, N5): an order's header, lines, payment and
 * journal can never come from different moments.
 */
function inSnapshot<T>(db: Db, read: (tx: Reader) => Promise<T>): Promise<T> {
  return db.transaction(read, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  })
}
import {
  orderItems,
  orders,
  ordersWithStatus,
  patients,
  paymentAttempts,
  payments,
  products,
  providers,
  users,
} from '../db/schema'

export type OrderView = 'provider' | 'patient'

const patientUsers = alias(users, 'patient_users')
const providerUsers = alias(users, 'provider_users')

/**
 * Order reads go through the orders_with_status view (revision 14.3b), whose
 * `effective_status` reports the derived awaiting_stock. `backorders` is the
 * order's latest direct child, for the link back; `priorOrders` is the order
 * it was split from (revision 15.3).
 */
const view = ordersWithStatus
const backorders = alias(ordersWithStatus, 'backorders')
const priorOrders = alias(orders, 'prior_orders')

/**
 * Revision 18.1: an order may have cancelled back-orders as history and at
 * most one live one. A live child is always the newest (none can be created
 * while one is live), so the newest child is the live one when there is one,
 * else the most recently cancelled.
 */
const latestBackorder = eq(
  backorders.id,
  sql`(select max(siblings.id) from ${orders} siblings where siblings.split_from_order_id = ${view.id})`,
)

/**
 * Revision 15.3: a back-order awaiting payment or stock is blocked by its
 * direct parent until that parent is paid; the chain pays in order.
 */
const blockedByOrderId = sql<
  number | null
>`case when ${view.status} = 'pending_payment' and ${priorOrders.status} <> 'paid' then ${priorOrders.id} end`.mapWith(
  (value: number | string | null) => (value === null ? null : Number(value)),
)

/**
 * A status filter on the view. Stored statuses compare the stored column, so
 * the status indexes still apply; pending_payment and awaiting_stock split
 * stored pending_payment by the derived status.
 */
export function effectiveStatusIn(statuses: readonly OrderStatus[]): SQL {
  const stored = STORED_ORDER_STATUSES.filter(
    (s) => s !== 'pending_payment' && statuses.includes(s),
  )
  const pending = statuses.filter(
    (s) => s === 'pending_payment' || s === 'awaiting_stock',
  )
  return (
    or(
      stored.length === 0 ? undefined : inArray(view.status, stored),
      pending.length === 0
        ? undefined
        : and(
            eq(view.status, 'pending_payment'),
            inArray(view.effectiveStatus, pending),
          ),
    ) ?? sql`false`
  )
}

function iso(date: Date | null) {
  return date === null ? null : date.toISOString()
}

async function selectOrders(db: Reader, where: SQL | undefined) {
  return db
    .select({
      id: view.id,
      status: view.effectiveStatus,
      storedStatus: view.status,
      patientId: view.patientId,
      patientName: patientUsers.name,
      patientAddress: patients.address,
      patientDateOfBirth: patients.dateOfBirth,
      providerId: view.providerId,
      providerName: providerUsers.name,
      subtotalCents: view.subtotalCents,
      platformFeeCents: view.platformFeeCents,
      totalCents: view.totalCents,
      createdAt: view.createdAt,
      sentAt: view.sentAt,
      paidAt: view.paidAt,
      cancelledAt: view.cancelledAt,
      revision: view.revision,
      splitFromOrderId: view.splitFromOrderId,
      backorderOrderId: backorders.id,
      backorderStatus: backorders.effectiveStatus,
      backorderStoredStatus: backorders.status,
      blockedByOrderId,
    })
    .from(view)
    .innerJoin(patients, eq(patients.id, view.patientId))
    .innerJoin(patientUsers, eq(patientUsers.id, patients.userId))
    .innerJoin(providers, eq(providers.id, view.providerId))
    .innerJoin(providerUsers, eq(providerUsers.id, providers.userId))
    .leftJoin(backorders, latestBackorder)
    .leftJoin(priorOrders, eq(priorOrders.id, view.splitFromOrderId))
    .where(where)
    .orderBy(desc(view.createdAt), desc(view.id))
}

type OrderRow = Awaited<ReturnType<typeof selectOrders>>[number]

/**
 * Revision 15.5: a draft shows its products as they are now; once sent, a line
 * shows the name and SKU snapshotted on send, so renaming a product never
 * changes what a sent or paid order says was sold.
 */
const lineProductName = sql<
  string | null
>`case when ${orders.status} = 'draft' then ${products.name} else ${orderItems.productName} end`
const lineSku = sql<
  string | null
>`case when ${orders.status} = 'draft' then ${products.sku} else ${orderItems.productSku} end`

async function selectLines(db: Reader, orderIds: number[]) {
  if (orderIds.length === 0) return []
  return db
    .select({
      lineId: orderItems.id,
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      productName: lineProductName,
      sku: lineSku,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
      unitCogsCents: orderItems.unitCogsCents,
      stockQuantity: products.stockQuantity,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.id))
}

/**
 * Revision 15.1: the order's latest unresolved payment attempt (pending,
 * succeeded without a payment, or in conflict), or undefined. While one holds
 * stock, the order's lines are exactly what it reserved.
 */
async function selectUnresolvedAttempt(db: Reader, orderId: number) {
  const [attempt] = await db
    .select({
      revision: paymentAttempts.revision,
      amountCents: paymentAttempts.amountCents,
      stockHeld: paymentAttempts.stockHeld,
    })
    .from(paymentAttempts)
    .leftJoin(payments, eq(payments.paymentAttemptId, paymentAttempts.id))
    .where(
      and(
        eq(paymentAttempts.orderId, orderId),
        inArray(paymentAttempts.status, ['pending', 'succeeded', 'conflict']),
        isNull(payments.id),
      ),
    )
    .orderBy(desc(paymentAttempts.revision), desc(paymentAttempts.execution))
    .limit(1)
  return attempt
}

type UnresolvedAttempt = Awaited<ReturnType<typeof selectUnresolvedAttempt>>

type LineRow = Awaited<ReturnType<typeof selectLines>>[number]

/**
 * Sent orders report the split snapshotted on send. Drafts are priced live, and
 * get no split while they would fail send validation (no lines, an incomplete
 * line, or a price below its minimum): the server never reports a split it
 * would refuse to charge.
 */
function splitFor(
  order: OrderRow,
  lines: LineRow[],
  journal: JournalSplit | undefined,
): OrderSplitDto | null {
  // Revision 16: a paid order's split is read from its journal's postings.
  if (order.storedStatus === 'paid' && journal !== undefined) {
    return { subtotalCents: journal.totalCents, ...journal }
  }
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
    splitFromOrderId: order.splitFromOrderId,
    backorderOrderId: order.backorderOrderId,
    blockedByOrderId: order.blockedByOrderId,
  }
}

/**
 * Revision 15.1: the stock each line can count on. Live stock, plus the line's
 * own units while an unresolved attempt holds them: a reservation is the
 * order's stock, not someone else's.
 */
function availableFor(l: LineRow, held: boolean) {
  if (l.stockQuantity === null) return null
  return held ? l.stockQuantity + l.quantity : l.stockQuantity
}

/**
 * Revision 14: what a pay can charge now, from live stock, while the order
 * awaits payment or stock; null otherwise. The same plan the pay makes, minus
 * the stock lock, so a pay with this quote succeeds unless stock moves first.
 * Revision 15.1: while an attempt holds the stock, the quote is that attempt's
 * reserved lines and amount.
 */
function quoteFor(
  order: OrderRow,
  lines: LineRow[],
  view: OrderView,
  held: boolean,
): PartialPaymentQuoteDto | null {
  if (
    order.storedStatus !== 'pending_payment' ||
    order.totalCents === null ||
    order.platformFeeCents === null
  ) {
    return null
  }
  const complete = lines.flatMap((l) =>
    l.productId === null ||
    l.unitPriceCents === null ||
    l.unitCogsCents === null
      ? []
      : [
          {
            productId: l.productId,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            unitCogsCents: l.unitCogsCents,
          },
        ],
  )
  const stock = new Map(
    lines.flatMap((l) => {
      const available = availableFor(l, held)
      return l.productId === null || available === null
        ? []
        : [[l.productId, available] as const]
    }),
  )
  // Revision 18.4 (L5): the halves share the stored fee. Revision 18.1: an
  // order with a live back-order can't split again, so a shortfall makes the
  // quote unpayable until restocked; every payable quote round-trips.
  return partialPaymentQuoteDto(planPartialPayment(complete, stock), view, {
    orderFeeCents: order.platformFeeCents,
    hasLiveBackorder:
      order.backorderOrderId !== null &&
      order.backorderStoredStatus !== 'cancelled',
  })
}

/** Per-line availability (revision 14.3), null when stock no longer matters. */
function lineAvailability(l: LineRow, open: boolean, held: boolean) {
  const available = availableFor(l, held)
  if (!open || available === null) {
    return { payableQuantity: null, shortQuantity: null }
  }
  const payableQuantity = Math.min(l.quantity, Math.max(available, 0))
  return { payableQuantity, shortQuantity: l.quantity - payableQuantity }
}

function providerSummary(
  order: OrderRow,
  lines: LineRow[],
  journal: JournalSplit | undefined,
): ProviderOrderSummaryDto {
  return {
    ...summaryBase(order),
    view: 'provider',
    split: splitFor(order, lines, journal),
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

function providerLine(l: LineRow, held: boolean): ProviderOrderLineDto {
  const { unitCogsCents, unitPriceCents } = l
  const availableQuantity = availableFor(l, held)
  return {
    lineId: l.lineId,
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
    availableQuantity,
    ...lineAvailability(l, true, held),
    minUnitPriceCents:
      unitCogsCents === null
        ? null
        : derived(() => minUnitPriceCents(unitCogsCents)),
  }
}

function patientLine(order: OrderRow, l: LineRow, held: boolean): OrderLineDto {
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
    lineId: l.lineId,
    productId: l.productId,
    productName: l.productName,
    sku: l.sku,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    lineTotalCents: l.quantity * l.unitPriceCents,
    availableQuantity:
      order.storedStatus === 'pending_payment' ? availableFor(l, held) : null,
    ...lineAvailability(l, order.storedStatus === 'pending_payment', held),
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
      eq(view.providerId, providerId),
      patientId === undefined ? undefined : eq(view.patientId, patientId),
    ),
  )
  const ids = rows.map((o) => o.id)
  const lines = groupLines(await selectLines(db, ids))
  const journalSplits = await selectJournalSplits(
    db,
    rows.filter((o) => o.storedStatus === 'paid').map((o) => o.id),
  )
  return rows.map((o) =>
    providerSummary(o, lines.get(o.id) ?? [], journalSplits.get(o.id)),
  )
}

/** Patients see only orders they were sent: never drafts or drafts cancelled unsent. */
export async function listPatientOrders(db: Db, patientId: number) {
  const rows = await selectOrders(
    db,
    and(
      eq(view.patientId, patientId),
      ne(view.status, 'draft'),
      isNotNull(view.sentAt),
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
  const [order] = await selectOrders(db, eq(view.id, orderId))
  if (!order) throw new Error(`Order ${orderId} disappeared`)
  await hooks.afterOrderHeader?.()
  const lines = await selectLines(db, [orderId])
  const attempt = await selectUnresolvedAttempt(db, orderId)
  return { order, lines, attempt, payment: await loadPayment(db, orderId) }
}

/** Revision 15 detail fields; `held` is whether an attempt holds the stock. */
function detailExtras(order: OrderRow, attempt: UnresolvedAttempt) {
  const paymentInProgress: PaymentInProgressDto | null =
    attempt === undefined
      ? null
      : { revision: attempt.revision, amountCents: attempt.amountCents }
  return {
    paymentInProgress,
    backorderStatus: order.backorderStatus,
    held: attempt?.stockHeld === true,
  }
}

async function readProviderOrderDetail(
  db: Reader,
  orderId: number,
  hooks?: ReadHooks,
): Promise<ProviderOrderDetailDto> {
  const { order, lines, attempt, payment } = await loadOne(db, orderId, hooks)
  const { held, ...extras } = detailExtras(order, attempt)
  const { journal, split } = await selectOrderJournal(db, orderId)
  return {
    ...providerSummary(order, lines, split),
    patientDateOfBirth: order.patientDateOfBirth,
    patientAddress: order.patientAddress,
    lines: lines.map((line) => providerLine(line, held)),
    payment,
    journal,
    partialPaymentQuote: quoteFor(order, lines, 'provider', held),
    ...extras,
  }
}

async function readPatientOrderDetail(
  db: Reader,
  orderId: number,
  hooks?: ReadHooks,
): Promise<PatientOrderDetailDto> {
  const { order, lines, attempt, payment } = await loadOne(db, orderId, hooks)
  const { held, ...extras } = detailExtras(order, attempt)
  return {
    ...patientSummary(order),
    patientAddress: order.patientAddress,
    lines: lines.map((line) => patientLine(order, line, held)),
    payment,
    partialPaymentQuote: quoteFor(order, lines, 'patient', held),
    ...extras,
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
 * 404 if missing, not the caller's, or (for its patient) unsent.
 */
export function loadOrderDetailFor(
  db: Db,
  user: Extract<CurrentUser, { role: 'provider' | 'patient' }>,
  orderId: number,
  hooks?: ReadHooks,
): Promise<ProviderOrderDetailDto | PatientOrderDetailDto> {
  return inSnapshot(db, async (tx) => {
    const order = await findOrderOwnership(tx, orderId)
    if (!order) throw notFound('Order')
    // Revision 18.4 (L6): another practice's or patient's order is 404, the
    // same as a missing one, so ids can't be probed.
    if (user.role === 'provider') {
      if (order.providerId !== user.providerId) throw notFound('Order')
      return readProviderOrderDetail(tx, orderId, hooks)
    }
    // Unsent orders (drafts, and drafts cancelled before sending) stay hidden.
    if (order.patientId !== user.patientId || order.sentAt === null) {
      throw notFound('Order')
    }
    return readPatientOrderDetail(tx, orderId, hooks)
  })
}

/**
 * The most relevant date for an order's state: when it was paid or cancelled,
 * else sent, else created. Only one of paidAt/cancelledAt is ever set, and each
 * is later than sentAt, so this equals the latest activity. Mirrors the
 * expression index orders_provider_status_activity_idx (migration 0006).
 */
export const orderActivityAt = sql<Date>`coalesce(${view.paidAt}, ${view.cancelledAt}, ${view.sentAt}, ${view.createdAt})`

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
    eq(view.providerId, providerId),
    status === 'all' ? undefined : effectiveStatusIn(status),
    patientId === undefined ? undefined : eq(view.patientId, patientId),
  )
  const awaitingOnly =
    status !== 'all' && status.length === 1 && status[0] === 'pending_payment'
  const ordering = awaitingOnly
    ? [asc(view.sentAt), asc(view.id)]
    : [desc(orderActivityAt), desc(view.id)]
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        id: view.id,
        patientId: view.patientId,
        patientName: patientUsers.name,
        patientDateOfBirth: patients.dateOfBirth,
        status: view.effectiveStatus,
        totalCents: view.totalCents,
        createdAt: view.createdAt,
        sentAt: view.sentAt,
        paidAt: view.paidAt,
        cancelledAt: view.cancelledAt,
        splitFromOrderId: view.splitFromOrderId,
        backorderOrderId: backorders.id,
        blockedByOrderId,
      })
      .from(view)
      .innerJoin(patients, eq(patients.id, view.patientId))
      .innerJoin(patientUsers, eq(patientUsers.id, patients.userId))
      .leftJoin(backorders, latestBackorder)
      .leftJoin(priorOrders, eq(priorOrders.id, view.splitFromOrderId))
      .where(where)
      .orderBy(...ordering)
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(view).where(where),
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
