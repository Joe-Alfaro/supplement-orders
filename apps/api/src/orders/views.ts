import {
  computeSplit,
  type LedgerEntryDto,
  type OrderSplitDto,
  type PatientOrderDetailDto,
  type PatientOrderSummaryDto,
  type PaymentDto,
  type ProviderOrderDetailDto,
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
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.id))
}

type LineRow = Awaited<ReturnType<typeof selectLines>>[number]

/**
 * Drafts are priced live from their lines. Once sent, the persisted snapshot is
 * authoritative for what the patient pays; COGS and margin come from the
 * snapshotted line costs.
 */
function splitFor(order: OrderRow, lines: LineRow[]): OrderSplitDto {
  const live =
    lines.length === 0
      ? {
          subtotalCents: 0,
          platformFeeCents: 0,
          totalCents: 0,
          cogsCents: 0,
          providerMarginCents: 0,
        }
      : computeSplit(lines)
  const { cogsCents, providerMarginCents } = live
  if (
    order.subtotalCents === null ||
    order.platformFeeCents === null ||
    order.totalCents === null
  ) {
    const { subtotalCents, platformFeeCents, totalCents } = live
    return {
      subtotalCents,
      platformFeeCents,
      totalCents,
      cogsCents,
      providerMarginCents,
    }
  }
  return {
    subtotalCents: order.subtotalCents,
    platformFeeCents: order.platformFeeCents,
    totalCents: order.totalCents,
    cogsCents,
    providerMarginCents,
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

function patientSummary(
  order: OrderRow,
  lines: LineRow[],
): PatientOrderSummaryDto {
  const { subtotalCents, platformFeeCents, totalCents } = splitFor(order, lines)
  return {
    ...summaryBase(order),
    view: 'patient',
    totals: { subtotalCents, platformFeeCents, totalCents },
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
  const lines = groupLines(
    await selectLines(
      db,
      rows.map((o) => o.id),
    ),
  )
  return rows.map((o) => patientSummary(o, lines.get(o.id) ?? []))
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
    patientAddress: order.patientAddress,
    lines: lines.map((l) => ({
      productId: l.productId,
      productName: l.productName,
      sku: l.sku,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.quantity * l.unitPriceCents,
      unitCogsCents: l.unitCogsCents,
      unitMarginCents: l.unitPriceCents - l.unitCogsCents,
    })),
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
    ...patientSummary(order, lines),
    patientAddress: order.patientAddress,
    lines: lines.map((l) => ({
      productId: l.productId,
      productName: l.productName,
      sku: l.sku,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.quantity * l.unitPriceCents,
    })),
    payment,
  }
}
