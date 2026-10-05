import {
  assertLedgerBalances,
  computeSplit,
  SplitValidationError,
  toLedgerEntries,
  type OrderLineInput,
  type SplitLine,
} from '@supplement-orders/domain'
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  ledgerEntries,
  orderItems,
  orders,
  patients,
  payments,
  products,
} from '../db/schema'
import { ApiError, forbidden, notFound } from '../http/errors'
import type { CurrentUser } from '../seams'
import type { AppContext } from '../server'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type ProviderUser = Extract<CurrentUser, { role: 'provider' }>
type PatientUser = Extract<CurrentUser, { role: 'patient' }>

// EMPTY_ORDER is order-level: no field, so the UI shows it in the general banner.
const SPLIT_ERROR_FIELDS: Record<SplitValidationError['code'], string | null> =
  {
    EMPTY_ORDER: null,
    INVALID_QUANTITY: 'quantity',
    INVALID_AMOUNT: 'unitPriceCents',
    PRICE_BELOW_COGS: 'unitPriceCents',
    UNSAFE_AMOUNT: 'unitPriceCents',
  }

/** computeSplit with its validation errors translated to 422 responses. */
function computeSplitOrThrow(lines: readonly SplitLine[]) {
  try {
    return computeSplit(lines)
  } catch (err) {
    if (!(err instanceof SplitValidationError)) throw err
    const leaf = SPLIT_ERROR_FIELDS[err.code]
    const field =
      err.lineIndex === undefined || leaf === null
        ? undefined
        : `lines.${err.lineIndex}.${leaf}`
    throw new ApiError(422, err.code, err.message, field)
  }
}

function idempotencyKeyFor(orderId: number) {
  return `order-${orderId}-payment`
}

/** Locks the order row for the rest of the transaction. */
async function lockOrder(tx: Tx, orderId: number) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update')
  if (!order) throw notFound('Order')
  return order
}

async function lockOwnedDraft(tx: Tx, user: ProviderUser, orderId: number) {
  const order = await lockOrder(tx, orderId)
  if (order.providerId !== user.providerId) {
    throw forbidden('This order belongs to another provider')
  }
  if (order.status !== 'draft') {
    throw new ApiError(
      409,
      'ORDER_NOT_DRAFT',
      `Order is ${order.status}; only drafts can be changed`,
    )
  }
  return order
}

function insufficientStock(index: number, available: number) {
  return new ApiError(
    422,
    'INSUFFICIENT_STOCK',
    `Only ${available} in stock`,
    `lines.${index}.quantity`,
  )
}

export async function createDraft(
  db: Db,
  user: ProviderUser,
  patientId: number,
) {
  const [patient] = await db
    .select({ providerId: patients.providerId })
    .from(patients)
    .where(eq(patients.id, patientId))
  if (!patient) {
    throw new ApiError(404, 'NOT_FOUND', 'Patient not found', 'patientId')
  }
  if (patient.providerId !== user.providerId) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'This patient belongs to another provider',
      'patientId',
    )
  }
  const [order] = await db
    .insert(orders)
    .values({ providerId: user.providerId, patientId })
    .returning({ id: orders.id })
  return order!.id
}

/**
 * Replaces every line of a draft. COGS is snapshotted from the product now and
 * refreshed on send. Lines are validated in request order so error fields
 * (`lines.N.*`) point at the request.
 */
export async function replaceDraftLines(
  db: Db,
  user: ProviderUser,
  orderId: number,
  lines: OrderLineInput[],
) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId)

    const seen = new Set<number>()
    lines.forEach((line, index) => {
      if (seen.has(line.productId)) {
        throw new ApiError(
          422,
          'DUPLICATE_PRODUCT',
          'A product can appear on only one line',
          `lines.${index}.productId`,
        )
      }
      seen.add(line.productId)
    })

    const productRows =
      lines.length === 0
        ? []
        : await tx
            .select()
            .from(products)
            .where(
              inArray(
                products.id,
                lines.map((l) => l.productId),
              ),
            )
    const byId = new Map(productRows.map((p) => [p.id, p]))
    const snapshotted = lines.map((line, index) => {
      const product = byId.get(line.productId)
      if (!product) {
        throw new ApiError(
          422,
          'UNKNOWN_PRODUCT',
          'Unknown product',
          `lines.${index}.productId`,
        )
      }
      if (line.quantity > product.stockQuantity) {
        throw insufficientStock(index, product.stockQuantity)
      }
      return { ...line, orderId, unitCogsCents: product.cogsCents }
    })
    if (snapshotted.length > 0) computeSplitOrThrow(snapshotted)

    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId))
    if (snapshotted.length > 0) await tx.insert(orderItems).values(snapshotted)
    await tx
      .update(orders)
      .set({ updatedAt: new Date() })
      .where(eq(orders.id, orderId))
  })
}

/**
 * Draft -> pending_payment. Re-snapshots COGS, validates via computeSplit, and
 * persists the split the patient will be charged. Notifies after commit.
 */
export async function sendOrder(
  { db, notifier }: AppContext,
  user: ProviderUser,
  orderId: number,
) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId)
    const lines = await tx
      .select({
        itemId: orderItems.id,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        unitCogsCents: products.cogsCents,
        stockQuantity: products.stockQuantity,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id))

    lines.forEach((line, index) => {
      if (line.quantity > line.stockQuantity) {
        throw insufficientStock(index, line.stockQuantity)
      }
    })
    const split = computeSplitOrThrow(lines)

    await Promise.all(
      lines.map((line) =>
        tx
          .update(orderItems)
          .set({ unitCogsCents: line.unitCogsCents })
          .where(eq(orderItems.id, line.itemId)),
      ),
    )
    const now = new Date()
    await tx
      .update(orders)
      .set({
        status: 'pending_payment',
        subtotalCents: split.subtotalCents,
        platformFeeCents: split.platformFeeCents,
        totalCents: split.totalCents,
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(orders.id, orderId))
  })

  // The order is already committed; a notification failure must not undo it.
  await notifier.notifyPatientOrderReady(orderId).catch((err: unknown) => {
    console.error(`[notifier] failed for order ${orderId}`, err)
  })
}

/**
 * The money path (ARCHITECTURE §6.4). One transaction: lock the order, reserve
 * stock, charge, record the payment, write and verify the three ledger rows,
 * mark paid. Any throw rolls everything back. Paying a paid order is a no-op.
 *
 * Stock is decremented before the charge so the only DB-side failures left after
 * money moves are unexpected ones; a retry reuses the order's idempotency key, so
 * the gateway does not charge twice.
 */
export async function payOrder(
  { db, gateway, payHooks, allowSimulatedFailure }: AppContext,
  user: PatientUser,
  orderId: number,
  simulateFailure: boolean,
) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (order.patientId !== user.patientId) {
      throw forbidden('This order belongs to another patient')
    }
    if (order.status === 'draft') throw notFound('Order')
    if (order.status === 'paid') return
    if (order.status !== 'pending_payment' || order.totalCents === null) {
      throw new ApiError(
        409,
        'ORDER_NOT_PAYABLE',
        `Order is ${order.status} and cannot be paid`,
      )
    }

    const lines = await tx
      .select({
        productId: orderItems.productId,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        unitCogsCents: orderItems.unitCogsCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id))
    const split = computeSplit(lines)
    if (split.totalCents !== order.totalCents) {
      throw new Error(
        `Order ${orderId} lines no longer match the sent total (${split.totalCents} != ${order.totalCents})`,
      )
    }

    await lines.reduce(async (prev, line, index) => {
      await prev
      const [updated] = await tx
        .update(products)
        .set({
          stockQuantity: sql`${products.stockQuantity} - ${line.quantity}`,
        })
        .where(
          and(
            eq(products.id, line.productId),
            gte(products.stockQuantity, line.quantity),
          ),
        )
        .returning({ id: products.id })
      if (!updated) {
        const [product] = await tx
          .select({ stock: products.stockQuantity })
          .from(products)
          .where(eq(products.id, line.productId))
        throw insufficientStock(index, product?.stock ?? 0)
      }
    }, Promise.resolve())

    const charge = await gateway.charge(
      {
        amountCents: order.totalCents,
        idempotencyKey: idempotencyKeyFor(orderId),
        description: `Supplement order ${orderId}`,
      },
      { simulateFailure: allowSimulatedFailure && simulateFailure },
    )
    if (charge.status !== 'succeeded') {
      throw new ApiError(
        402,
        'PAYMENT_FAILED',
        charge.failureMessage ?? 'Payment was declined',
      )
    }

    const [payment] = await tx
      .insert(payments)
      .values({
        orderId,
        amountCents: order.totalCents,
        idempotencyKey: idempotencyKeyFor(orderId),
        gatewayReference: charge.reference,
      })
      .returning({ id: payments.id, amountCents: payments.amountCents })
    if (!payment)
      throw new Error(`Payment insert for order ${orderId} returned no row`)

    const entries = toLedgerEntries(split)
    assertLedgerBalances(entries, payment.amountCents)
    await tx.insert(ledgerEntries).values(
      entries.map((entry) => ({
        orderId,
        paymentId: payment.id,
        type: entry.type,
        amountCents: entry.amountCents,
      })),
    )
    await payHooks.afterLedgerInsert?.()

    const now = new Date()
    await tx
      .update(orders)
      .set({ status: 'paid', paidAt: now, updatedAt: now })
      .where(eq(orders.id, orderId))
  })
}
