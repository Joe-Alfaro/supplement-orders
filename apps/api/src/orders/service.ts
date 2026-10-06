import {
  assertLedgerBalances,
  computeSplit,
  SplitValidationError,
  toLedgerEntries,
  type DraftLine,
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
    PRICE_BELOW_MINIMUM: 'unitPriceCents',
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
 * Replaces every line of a draft, keeping request order. Lines may be incomplete
 * (no product or no price yet). Saving rejects only what can never become valid:
 * a duplicate or unknown product. Completeness, stock, and the minimum price are
 * checked on send. Wholesale cost is snapshotted now and refreshed on send.
 */
export async function replaceDraftLines(
  db: Db,
  user: ProviderUser,
  orderId: number,
  lines: DraftLine[],
) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId)

    const productIds = lines.flatMap((l) =>
      l.productId === null ? [] : [l.productId],
    )
    const seen = new Set<number>()
    lines.forEach((line, index) => {
      if (line.productId === null) return
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
      productIds.length === 0
        ? []
        : await tx
            .select({ id: products.id, cogsCents: products.cogsCents })
            .from(products)
            .where(inArray(products.id, productIds))
    const cogsById = new Map(productRows.map((p) => [p.id, p.cogsCents]))
    const rows = lines.map((line, index) => {
      if (line.productId === null)
        return { ...line, orderId, unitCogsCents: null }
      const unitCogsCents = cogsById.get(line.productId)
      if (unitCogsCents === undefined) {
        throw new ApiError(
          422,
          'UNKNOWN_PRODUCT',
          'Unknown product',
          `lines.${index}.productId`,
        )
      }
      return { ...line, orderId, unitCogsCents }
    })

    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId))
    if (rows.length > 0) await tx.insert(orderItems).values(rows)
    await tx
      .update(orders)
      .set({ updatedAt: new Date() })
      .where(eq(orders.id, orderId))
  })
}

function incompleteLine(index: number, part: 'productId' | 'unitPriceCents') {
  const what = part === 'productId' ? 'a product' : 'a price'
  return new ApiError(
    422,
    'INCOMPLETE_LINE',
    `Line ${index + 1} needs ${what} before the order can be sent`,
    `lines.${index}.${part}`,
  )
}

/**
 * Draft -> pending_payment. Requires at least one line, every line complete,
 * enough stock, and every price at or above its minimum (via computeSplit).
 * Re-snapshots wholesale cost and persists the split. Notifies after commit.
 */
export async function sendOrder(
  { db, notifier }: AppContext,
  user: ProviderUser,
  orderId: number,
) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId)
    const rows = await tx
      .select({
        itemId: orderItems.id,
        productId: orderItems.productId,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        currentCogsCents: products.cogsCents,
        stockQuantity: products.stockQuantity,
      })
      .from(orderItems)
      .leftJoin(products, eq(products.id, orderItems.productId))
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id))

    if (rows.length === 0) {
      throw new ApiError(
        422,
        'EMPTY_ORDER',
        'Add at least one line before sending',
      )
    }
    const lines = rows.map((row, index) => {
      if (
        row.productId === null ||
        row.currentCogsCents === null ||
        row.stockQuantity === null
      ) {
        throw incompleteLine(index, 'productId')
      }
      if (row.unitPriceCents === null) {
        throw incompleteLine(index, 'unitPriceCents')
      }
      return {
        itemId: row.itemId,
        quantity: row.quantity,
        unitPriceCents: row.unitPriceCents,
        unitCogsCents: row.currentCogsCents,
        stockQuantity: row.stockQuantity,
      }
    })
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
 * Permanently deletes a draft and its lines. Safe because a draft was never sent
 * and so has no payment or ledger rows. Takes the order row lock, so a concurrent
 * send serializes with it: if send wins, the delete gets 409 ORDER_NOT_DRAFT; if
 * the delete wins, the send finds no order (404).
 */
export async function deleteDraft(db: Db, user: ProviderUser, orderId: number) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId)
    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId))
    await tx.delete(orders).where(eq(orders.id, orderId))
  })
}

/**
 * Cancelled -> draft (revision 8). Clears sentAt, cancelledAt and the sent
 * snapshot so the order is an ordinary draft again (hidden from the patient until
 * re-sent), and keeps its lines. Stock is untouched: only payment moves stock.
 */
export async function reopenOrder(db: Db, user: ProviderUser, orderId: number) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (order.providerId !== user.providerId) {
      throw forbidden('This order belongs to another provider')
    }
    if (order.status !== 'cancelled') {
      throw new ApiError(
        409,
        'ORDER_NOT_REOPENABLE',
        `Order is ${order.status}; only cancelled orders can be reopened`,
      )
    }
    await tx
      .update(orders)
      .set({
        status: 'draft',
        sentAt: null,
        cancelledAt: null,
        subtotalCents: null,
        platformFeeCents: null,
        totalCents: null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
  })
}

/**
 * Provider cancels a pending order (revision 8: drafts are deleted, not
 * cancelled). Takes the same row lock as pay, so
 * a concurrent cancel and pay serialize: whichever commits first wins and the
 * other gets a 409. No ledger rows, no stock change (stock only moves on pay).
 * The patient is notified only if the order had been sent to them.
 */
export async function cancelOrder(
  { db, notifier }: AppContext,
  user: ProviderUser,
  orderId: number,
) {
  const wasSent = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (order.providerId !== user.providerId) {
      throw forbidden('This order belongs to another provider')
    }
    if (order.status !== 'pending_payment') {
      throw new ApiError(
        409,
        'ORDER_NOT_CANCELLABLE',
        `Order is ${order.status} and cannot be cancelled`,
      )
    }
    const now = new Date()
    await tx
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(eq(orders.id, orderId))
    return order.sentAt !== null
  })

  if (!wasSent) return
  // Already committed; a notification failure must not undo the cancel.
  await notifier.notifyPatientOrderCancelled(orderId).catch((err: unknown) => {
    console.error(`[notifier] cancel notice failed for order ${orderId}`, err)
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
    // The patient never saw an unsent order, including a draft cancelled before sending.
    if (order.sentAt === null) throw notFound('Order')
    if (order.status === 'paid') return
    if (order.status !== 'pending_payment' || order.totalCents === null) {
      throw new ApiError(
        409,
        'ORDER_NOT_PAYABLE',
        `Order is ${order.status} and cannot be paid`,
      )
    }

    const rows = await tx
      .select({
        productId: orderItems.productId,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        unitCogsCents: orderItems.unitCogsCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id))
    // Send is the only way out of draft and it rejects incomplete lines.
    const lines = rows.map(
      ({ productId, unitPriceCents, unitCogsCents, quantity }) => {
        if (
          productId === null ||
          unitPriceCents === null ||
          unitCogsCents === null
        ) {
          throw new Error(`Order ${orderId} was sent with an incomplete line`)
        }
        return { productId, quantity, unitPriceCents, unitCogsCents }
      },
    )
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
