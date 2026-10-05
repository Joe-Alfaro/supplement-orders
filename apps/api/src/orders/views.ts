import {
  computeSplit,
  marginBpsFromPrice,
  minUnitPriceCents,
  SplitValidationError,
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
import { and, asc, desc, eq, inArray, ne, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '../db/client'
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

async function selectOrders(db: Db, where: SQL | undefined) {
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

async function selectLines(db: Db, orderIds: number[]) {
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

function providerLine(l: LineRow): ProviderOrderLineDto {
  const hasProduct = l.unitCogsCents !== null
  return {
    productId: l.productId,
    productName: l.productName,
    sku: l.sku,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    lineTotalCents:
      l.unitPriceCents === null ? null : l.quantity * l.unitPriceCents,
    unitCogsCents: l.unitCogsCents,
    marginBps:
      l.unitCogsCents === null || l.unitPriceCents === null
        ? null
        : marginBpsFromPrice(l.unitCogsCents, l.unitPriceCents),
    stockQuantity: l.stockQuantity,
    minUnitPriceCents: hasProduct
      ? minUnitPriceCents(l.unitCogsCents ?? 0)
      : null,
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

/** Patients never see drafts. */
export async function listPatientOrders(db: Db, patientId: number) {
  const rows = await selectOrders(
    db,
    and(eq(orders.patientId, patientId), ne(orders.status, 'draft')),
  )
  return rows.map(patientSummary)
}

/** Ownership-check columns for an order, or undefined if it does not exist. */
export async function findOrderOwnership(db: Db, orderId: number) {
  const [row] = await db
    .select({
      id: orders.id,
      providerId: orders.providerId,
      patientId: orders.patientId,
      status: orders.status,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
  return row
}

async function loadPayment(db: Db, orderId: number) {
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

async function loadOne(db: Db, orderId: number) {
  const [order] = await selectOrders(db, eq(orders.id, orderId))
  if (!order) throw new Error(`Order ${orderId} disappeared`)
  const lines = await selectLines(db, [orderId])
  return { order, lines, payment: await loadPayment(db, orderId) }
}

export async function loadProviderOrderDetail(
  db: Db,
  orderId: number,
): Promise<ProviderOrderDetailDto> {
  const { order, lines, payment } = await loadOne(db, orderId)
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

export async function loadPatientOrderDetail(
  db: Db,
  orderId: number,
): Promise<PatientOrderDetailDto> {
  const { order, lines, payment } = await loadOne(db, orderId)
  return {
    ...patientSummary(order),
    patientAddress: order.patientAddress,
    lines: lines.map(patientLine),
    payment,
  }
}
