import {
  computeSplit,
  partialPaymentQuoteDto,
  planPartialPayment,
  samePayableLines,
  SplitValidationError,
  ORDER_STATUS_LABELS,
  type DraftLine,
  type ExpectedPayableLine,
  type LowStockLineDto,
  type OrderStatus,
  type PartialPaymentPlan,
  type PayMode,
  type PartialPaymentQuoteDto,
  type SplitLine,
  type StockAvailabilityDto,
} from '@supplement-orders/domain'
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  orderItems,
  orders,
  patients,
  paymentAttempts,
  payments,
  products,
} from '../db/schema'
import { ApiError, forbidden, notFound } from '../http/errors'
import { postPaymentJournal } from '../ledger/journals'
import { IDEMPOTENCY_KEY_REUSED, type CurrentUser } from '../seams'
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

/**
 * The status as it reads mid-sentence in a message the UI shows verbatim,
 * e.g. "This order is awaiting payment". Never the raw enum value.
 */
function statusInSentence(status: OrderStatus) {
  if (status === 'draft') return 'a draft'
  return ORDER_STATUS_LABELS[status].toLowerCase()
}

async function lockOwnedDraft(
  tx: Tx,
  user: ProviderUser,
  orderId: number,
  action: 'edited' | 'sent' | 'deleted',
) {
  const order = await lockOrder(tx, orderId)
  if (order.providerId !== user.providerId) {
    throw forbidden('This order belongs to another provider')
  }
  // An unreconciled charge outranks the status conflict (revision 9): edits and
  // deletes report PAYMENT_NEEDS_RECONCILIATION whatever the order's status.
  if (action !== 'sent') await assertNoUnreconciledCharge(tx, orderId)
  if (order.status !== 'draft') {
    throw new ApiError(
      409,
      'ORDER_NOT_DRAFT',
      `This order is ${statusInSentence(order.status)}; only drafts can be ${action}.`,
    )
  }
  return order
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
 * checked on send. Wholesale cost, product name and SKU (revision 15.5) are
 * snapshotted now and refreshed on send.
 */
export async function replaceDraftLines(
  db: Db,
  user: ProviderUser,
  orderId: number,
  lines: DraftLine[],
) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId, 'edited')

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
            .select({
              id: products.id,
              cogsCents: products.cogsCents,
              name: products.name,
              sku: products.sku,
            })
            .from(products)
            .where(inArray(products.id, productIds))
    const productById = new Map(productRows.map((p) => [p.id, p]))
    const rows = lines.map((line, index) => {
      if (line.productId === null) {
        return {
          ...line,
          orderId,
          unitCogsCents: null,
          productName: null,
          productSku: null,
        }
      }
      const product = productById.get(line.productId)
      if (product === undefined) {
        throw new ApiError(
          422,
          'UNKNOWN_PRODUCT',
          'Unknown product',
          `lines.${index}.productId`,
        )
      }
      return {
        ...line,
        orderId,
        unitCogsCents: product.cogsCents,
        productName: product.name,
        productSku: product.sku,
      }
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
 * and every price at or above its minimum (via computeSplit). Quantities above
 * available stock need `acknowledgeLowStock` (revision 14); stock is not
 * reserved here. Re-snapshots wholesale cost, product name and SKU, and
 * persists the split. Notifies after commit.
 */
export async function sendOrder(
  { db, notifier }: AppContext,
  user: ProviderUser,
  orderId: number,
  { acknowledgeLowStock = false }: { acknowledgeLowStock?: boolean } = {},
) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId, 'sent')
    const rows = await tx
      .select({
        itemId: orderItems.id,
        productId: orderItems.productId,
        productName: products.name,
        productSku: products.sku,
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
        row.productName === null ||
        row.productSku === null ||
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
        productId: row.productId,
        productName: row.productName,
        productSku: row.productSku,
        quantity: row.quantity,
        unitPriceCents: row.unitPriceCents,
        unitCogsCents: row.currentCogsCents,
        stockQuantity: row.stockQuantity,
      }
    })
    const split = computeSplitOrThrow(lines)
    const lowStock = lines
      .filter((line) => line.quantity > line.stockQuantity)
      .map((line): LowStockLineDto => ({
        lineId: line.itemId,
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        availableQuantity: line.stockQuantity,
      }))
    if (lowStock.length > 0 && !acknowledgeLowStock) {
      throw new ApiError(
        409,
        'LOW_STOCK_UNACKNOWLEDGED',
        'Some lines exceed the stock available now. Confirm to send anyway.',
        undefined,
        { lines: lowStock },
      )
    }

    await Promise.all(
      lines.map((line) =>
        tx
          .update(orderItems)
          .set({
            unitCogsCents: line.unitCogsCents,
            productName: line.productName,
            productSku: line.productSku,
          })
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
        // Every send is a new quote the patient must consent to (revision 9, H1).
        revision: sql`${orders.revision} + 1`,
      })
      .where(eq(orders.id, orderId))
  })

  // The order is already committed; a notification failure must not undo it.
  await notifier.notifyPatientOrderReady(orderId).catch((err: unknown) => {
    console.error(`[notifier] failed for order ${orderId}`, err)
  })
}

/**
 * Revision 15.3: the ids of every back-order downstream of `orderId` (its
 * child, the child's child, and so on), ascending. A back-order is always
 * created after the order it splits from, so ascending id is chain order.
 */
async function descendantIds(tx: Tx, orderId: number): Promise<number[]> {
  const rows = await tx.execute<{ id: number }>(sql`
    with recursive chain(id) as (
      select id from orders where split_from_order_id = ${orderId}
      union all
      select o.id from orders o join chain c on o.split_from_order_id = c.id
    )
    select id from chain order by id`)
  return rows.rows.map((row) => Number(row.id))
}

/**
 * Locks every downstream back-order of an already locked order, in ascending
 * id (revision 15.3), and returns them in that order. A split only happens
 * under the lock of the order being split, so once the whole chain is locked
 * it can't grow; if it grew while locking, lock the newcomers too.
 */
async function lockDescendants(tx: Tx, orderId: number): Promise<Order[]> {
  const ids = await descendantIds(tx, orderId)
  if (ids.length === 0) return []
  const locked = await tx
    .select()
    .from(orders)
    .where(inArray(orders.id, ids))
    .orderBy(asc(orders.id))
    .for('update')
  const after = await descendantIds(tx, orderId)
  if (after.length === ids.length) return locked
  return lockDescendants(tx, orderId)
}

/**
 * Permanently deletes a draft and its lines. Safe because a draft was never sent
 * and so has no payment or journal. Takes the order row lock, so a concurrent
 * send serializes with it: if send wins, the delete gets 409 ORDER_NOT_DRAFT; if
 * the delete wins, the send finds no order (404).
 *
 * Revision 15.3: a reopened original can still have back-orders, cancelled with
 * it and never paid. They are deleted with it, in the same transaction.
 */
export async function deleteDraft(db: Db, user: ProviderUser, orderId: number) {
  await db.transaction(async (tx) => {
    await lockOwnedDraft(tx, user, orderId, 'deleted')
    const chain = await lockDescendants(tx, orderId)
    const chainIds = chain.map((o) => o.id)
    await assertNoUnreconciledCharge(tx, chainIds)
    const paid = chain.find((o) => o.status === 'paid')
    if (paid) {
      throw new ApiError(
        409,
        'ORDER_NOT_DRAFT',
        `Back-order #${paid.id} of this order is paid, so the order can't be deleted.`,
      )
    }
    const ids = [orderId, ...chainIds]
    // A reopened draft may keep failed attempts from earlier sends; they hold no money.
    await tx
      .delete(paymentAttempts)
      .where(inArray(paymentAttempts.orderId, ids))
    await tx.delete(orderItems).where(inArray(orderItems.orderId, ids))
    // One statement, so each back-order's link to its parent goes with it.
    await tx.delete(orders).where(inArray(orders.id, ids))
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
    await assertNoUnreconciledCharge(tx, orderId)
    if (order.splitFromOrderId !== null) {
      throw new ApiError(
        409,
        'BACKORDER_NOT_EDITABLE',
        'This is a back-order; it can be cancelled but never edited.',
      )
    }
    if (order.status !== 'cancelled') {
      throw new ApiError(
        409,
        'ORDER_NOT_REOPENABLE',
        `This order is ${statusInSentence(order.status)}; only cancelled orders can be reopened.`,
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
 * other gets a 409. No journal, no stock change (stock only moves on pay).
 * The patient is notified only if the order had been sent to them.
 *
 * Revision 15.3: every downstream back-order awaiting payment or stock is
 * cancelled with it, its chain locked in ascending id. An unresolved payment
 * attempt anywhere in that chain refuses the whole cancel (409) and changes
 * nothing. Back-orders already cancelled stay as they are.
 */
export async function cancelOrder(
  { db, notifier }: AppContext,
  user: ProviderUser,
  orderId: number,
) {
  const sentIds = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (order.providerId !== user.providerId) {
      throw forbidden('This order belongs to another provider')
    }
    await assertNoUnreconciledCharge(tx, orderId)
    if (order.status !== 'pending_payment') {
      throw new ApiError(
        409,
        'ORDER_NOT_CANCELLABLE',
        `This order is ${statusInSentence(order.status)}; only orders awaiting payment can be cancelled.`,
      )
    }
    // Revision 15.3: the downstream back-orders go with it, all or nothing.
    const chain = await lockDescendants(tx, orderId)
    await assertNoUnreconciledCharge(
      tx,
      chain.map((o) => o.id),
    )
    const cancelled = [
      order,
      ...chain.filter((o) => o.status === 'pending_payment'),
    ]
    const now = new Date()
    await tx
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(
        inArray(
          orders.id,
          cancelled.map((o) => o.id),
        ),
      )
    return cancelled.filter((o) => o.sentAt !== null).map((o) => o.id)
  })

  // Already committed; a notification failure must not undo the cancel.
  await Promise.all(
    sentIds.map((id) =>
      notifier.notifyPatientOrderCancelled(id).catch((err: unknown) => {
        console.error(`[notifier] cancel notice failed for order ${id}`, err)
      }),
    ),
  )
}

/** One idempotency key per quote: a re-sent order is a new quote with a new key. */
/**
 * One idempotency key per payment execution (revision 10). A new execution,
 * and so a new key, exists only after the previous one was definitively
 * declined; an unresolved outcome always reuses its key.
 */
function idempotencyKeyFor(
  orderId: number,
  revision: number,
  execution: number,
) {
  return `order-${orderId}-r${revision}-e${execution}`
}

function orderChanged(partialPaymentQuote?: PartialPaymentQuoteDto) {
  return new ApiError(
    409,
    'ORDER_CHANGED',
    'This order changed since you opened it. Review the new total before paying.',
    undefined,
    partialPaymentQuote === undefined ? {} : { partialPaymentQuote },
  )
}

/**
 * Revision 9 (H2): a pending or succeeded payment attempt with no payment row
 * means money may have moved without a recorded payment. Until a retried pay
 * resolves it, the order must not be cancelled, reopened, deleted or edited.
 * (The contract names succeeded attempts; pending ones are blocked too, because
 * the gateway call runs outside the order lock and a cancel committed while a
 * charge is in flight would strand that charge on an order that can't be paid.)
 */
async function assertNoUnreconciledCharge(
  tx: Tx,
  orderIds: number | readonly number[],
) {
  const ids = typeof orderIds === 'number' ? [orderIds] : [...orderIds]
  if (ids.length === 0) return
  const [open] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .leftJoin(payments, eq(payments.paymentAttemptId, paymentAttempts.id))
    .where(
      and(
        inArray(paymentAttempts.orderId, ids),
        inArray(paymentAttempts.status, ['pending', 'succeeded', 'conflict']),
        isNull(payments.id),
      ),
    )
    .limit(1)
  if (open) {
    throw new ApiError(
      409,
      'PAYMENT_NEEDS_RECONCILIATION',
      'A payment for this order is being finalized. Try again shortly or contact support.',
    )
  }
}

interface PayLine {
  index: number
  /** The order_items row id. */
  lineId: number
  productId: number
  quantity: number
  unitPriceCents: number
  unitCogsCents: number
  productName: string | null
  productSku: string | null
}

/** The snapshotted lines of a sent order, in line order, with their indexes. */
async function loadPayLines(tx: Tx, orderId: number): Promise<PayLine[]> {
  const rows = await tx
    .select({
      lineId: orderItems.id,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
      unitCogsCents: orderItems.unitCogsCents,
      productName: orderItems.productName,
      productSku: orderItems.productSku,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id))
  // Send is the only way out of draft and it rejects incomplete lines.
  return rows.map(
    (
      {
        lineId,
        productId,
        unitPriceCents,
        unitCogsCents,
        quantity,
        productName,
        productSku,
      },
      index,
    ) => {
      if (
        productId === null ||
        unitPriceCents === null ||
        unitCogsCents === null
      ) {
        throw new Error(`Order ${orderId} was sent with an incomplete line`)
      }
      return {
        index,
        lineId,
        productId,
        quantity,
        unitPriceCents,
        unitCogsCents,
        productName,
        productSku,
      }
    },
  )
}

function byProductId(lines: PayLine[]) {
  return [...lines].sort((a, b) => a.productId - b.productId)
}

/**
 * Takes the order's stock, conditionally and in ascending product id (M2), so two
 * orders sharing products always lock product rows in the same order and cannot
 * deadlock. Pay checks stock under lockStock first, so a shortfall here is only
 * possible on the legacy paths; it is a 409 INSUFFICIENT_STOCK naming the line.
 */
async function decrementStock(tx: Tx, lines: PayLine[]) {
  await byProductId(lines).reduce(async (prev, line) => {
    await prev
    const [updated] = await tx
      .update(products)
      .set({ stockQuantity: sql`${products.stockQuantity} - ${line.quantity}` })
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
      throw new ApiError(
        409,
        'INSUFFICIENT_STOCK',
        `Only ${product?.stock ?? 0} in stock`,
        `lines.${line.index}.quantity`,
      )
    }
  }, Promise.resolve())
}

/** Gives back stock taken by decrementStock, in the same product-id order. */
async function releaseStock(tx: Tx, lines: PayLine[]) {
  await byProductId(lines).reduce(async (prev, line) => {
    await prev
    await tx
      .update(products)
      .set({ stockQuantity: sql`${products.stockQuantity} + ${line.quantity}` })
      .where(eq(products.id, line.productId))
  }, Promise.resolve())
}

export interface PayRequest {
  expectedRevision: number
  expectedTotalCents: number
  simulateFailure: boolean
  /** Revision 14; `full` unless the patient chose to pay for what is in stock. */
  mode: PayMode
  /** Revision 15.2: the in-stock lines the patient approved (`available` only). */
  expectedPayableLines?: readonly ExpectedPayableLine[]
}

function asPayable(lines: readonly PayLine[]): ExpectedPayableLine[] {
  return lines.map(({ productId, quantity }) => ({ productId, quantity }))
}

/**
 * Revision 15.2: an `available` pay approves exactly these lines; any other
 * set, even at the same revision and total, is a changed order.
 */
function approvesLines(request: PayRequest, lines: readonly PayLine[]) {
  return (
    request.mode !== 'available' ||
    samePayableLines(request.expectedPayableLines ?? [], asPayable(lines))
  )
}

/**
 * Revision 15.3: a back-order can't be paid while the order it was split from
 * is unpaid, whatever the stock. Paid is final, so no lock is needed on it.
 */
async function assertPriorOrderPaid(tx: Tx, order: Order) {
  if (order.splitFromOrderId === null) return
  const [prior] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.id, order.splitFromOrderId), ne(orders.status, 'paid')),
    )
  if (!prior) return
  throw new ApiError(
    409,
    'PRIOR_ORDER_UNPAID',
    `Pay order #${prior.id} first; this back-order can be paid once it is.`,
    undefined,
    { priorOrderId: prior.id },
  )
}

type Order = typeof orders.$inferSelect
type PayPlan = PartialPaymentPlan<PayLine>

/**
 * Locks the order's product rows in ascending id (the same order decrementStock
 * uses, M2) and returns their available stock, so the plan made from it still
 * holds when the stock is reserved in the same transaction.
 */
async function lockStock(tx: Tx, lines: PayLine[]) {
  const rows = await tx
    .select({ id: products.id, stock: products.stockQuantity })
    .from(products)
    .where(
      inArray(
        products.id,
        lines.map((l) => l.productId),
      ),
    )
    .orderBy(asc(products.id))
    .for('update')
  return new Map(rows.map((r) => [r.id, r.stock]))
}

function insufficientStock(
  lines: PayLine[],
  stock: ReadonlyMap<number, number>,
  partialPaymentQuote: PartialPaymentQuoteDto,
) {
  const availability = lines.map((line): StockAvailabilityDto => ({
    lineId: line.lineId,
    productId: line.productId,
    quantity: line.quantity,
    availableQuantity: Math.max(stock.get(line.productId) ?? 0, 0),
  }))
  return new ApiError(
    409,
    'INSUFFICIENT_STOCK',
    'Some items are no longer in stock in the quantity ordered.',
    undefined,
    { availability, partialPaymentQuote },
  )
}

async function findBackorder(tx: Tx, orderId: number) {
  const [child] = await tx
    .select({ id: orders.id, splitFromRevision: orders.splitFromRevision })
    .from(orders)
    .where(eq(orders.splitFromOrderId, orderId))
  return child
}

/**
 * Revision 14.5 replay: an `available` pay retried after its split committed
 * names the revision before the split. When this order's back-order came from
 * exactly that quote, the split bumped the revision by one, and the reduced
 * total is what the patient consented to, the retry continues as a pay of the
 * current revision instead of splitting again.
 */
async function effectiveRevision(tx: Tx, order: Order, request: PayRequest) {
  const { mode, expectedRevision, expectedTotalCents } = request
  if (
    mode !== 'available' ||
    order.revision !== expectedRevision + 1 ||
    order.totalCents !== expectedTotalCents
  ) {
    return expectedRevision
  }
  const child = await findBackorder(tx, order.id)
  return child?.splitFromRevision === expectedRevision
    ? order.revision
    : expectedRevision
}

/**
 * Revision 14.5 step 4, inside the prepare transaction under the order lock:
 * moves the shortfall to one new back-order (sent, revision 1, same patient
 * and provider, original unit prices and cogs snapshots), reduces this order
 * to the payable lines, re-snapshots its totals and bumps its revision.
 * Returns the order's new revision.
 */
async function splitOrder(
  tx: Tx,
  order: Order,
  plan: PayPlan,
  expectedRevision: number,
) {
  const backorderSplit = computeSplit(plan.backorderLines)
  const paySplit = computeSplit(plan.payLines)
  const now = new Date()
  const [backorder] = await tx
    .insert(orders)
    .values({
      providerId: order.providerId,
      patientId: order.patientId,
      status: 'pending_payment',
      subtotalCents: backorderSplit.subtotalCents,
      platformFeeCents: backorderSplit.platformFeeCents,
      totalCents: backorderSplit.totalCents,
      sentAt: now,
      revision: 1,
      splitFromOrderId: order.id,
      splitFromRevision: expectedRevision,
    })
    .returning({ id: orders.id })
  if (!backorder) {
    throw new Error(`Back-order insert for order ${order.id} returned no row`)
  }
  await tx.insert(orderItems).values(
    plan.backorderLines.map((line) => ({
      orderId: backorder.id,
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      unitCogsCents: line.unitCogsCents,
      productName: line.productName,
      productSku: line.productSku,
    })),
  )
  const kept = new Set(plan.payLines.map((line) => line.lineId))
  await tx
    .delete(orderItems)
    .where(
      and(
        eq(orderItems.orderId, order.id),
        notInArray(orderItems.id, [...kept]),
      ),
    )
  await Promise.all(
    plan.payLines.map((line) =>
      tx
        .update(orderItems)
        .set({ quantity: line.quantity })
        .where(eq(orderItems.id, line.lineId)),
    ),
  )
  const revision = order.revision + 1
  await tx
    .update(orders)
    .set({
      subtotalCents: paySplit.subtotalCents,
      platformFeeCents: paySplit.platformFeeCents,
      totalCents: paySplit.totalCents,
      revision,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id))
  return revision
}

type Attempt = typeof paymentAttempts.$inferSelect

function needsReconciliation() {
  return new ApiError(
    409,
    'PAYMENT_NEEDS_RECONCILIATION',
    'A payment for this order is being finalized. Try again shortly or contact support.',
  )
}

/**
 * Step 1 (one committed transaction, under the order lock): validate the quote
 * the patient saw (H1), then pick the execution to charge. An unresolved
 * execution (pending, succeeded without a payment, or conflict) is reused with
 * its key, so no outcome is ever left behind a new key. Only after a decline
 * does a new execution start, with a new key and a fresh stock reservation.
 * A new execution plans from current stock (revision 14): `full` refuses any
 * shortfall; `available` moves it to a back-order first, in this transaction.
 * Returns null when the order is already paid at this quote.
 */
async function preparePayment(
  db: Db,
  user: PatientUser,
  orderId: number,
  request: PayRequest,
): Promise<Attempt | null> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (order.patientId !== user.patientId) {
      throw forbidden('This order belongs to another patient')
    }
    // The patient never saw an unsent order, including a draft cancelled before sending.
    if (order.sentAt === null) throw notFound('Order')
    const { expectedTotalCents, mode } = request
    const expectedRevision = await effectiveRevision(tx, order, request)
    if (order.status === 'paid') {
      // A replay must name the quote that was paid: same revision and total.
      if (
        order.revision !== expectedRevision ||
        order.totalCents !== expectedTotalCents
      ) {
        throw orderChanged()
      }
      return null
    }
    if (order.status !== 'pending_payment' || order.totalCents === null) {
      throw new ApiError(
        409,
        'ORDER_NOT_PAYABLE',
        `This order is ${statusInSentence(order.status)} and can't be paid.`,
      )
    }
    const attempts = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId))
      .orderBy(asc(paymentAttempts.revision), asc(paymentAttempts.execution))
    // An unresolved attempt is always completed; only a new charge waits for
    // the prior order in the chain (revision 15.3).
    if (attempts.every((a) => a.status === 'declined')) {
      await assertPriorOrderPaid(tx, order)
    }
    // A full pay's quote is the stored total; an available pay's depends on
    // stock, so it is checked once the plan is made.
    if (
      mode === 'full' &&
      (order.revision !== expectedRevision ||
        order.totalCents !== expectedTotalCents)
    ) {
      throw orderChanged()
    }

    // An unresolved outcome from an earlier quote must be settled first (N1).
    const olderUnresolved = attempts.some(
      (a) => a.revision !== order.revision && a.status !== 'declined',
    )
    if (olderUnresolved) throw needsReconciliation()

    const lines = await loadPayLines(tx, orderId)
    const latest = attempts.filter((a) => a.revision === order.revision).at(-1)
    if (latest && latest.status !== 'declined') {
      // The stock is already held by this execution, so there is nothing to
      // plan: it is the same quote, retried.
      if (
        order.revision !== expectedRevision ||
        order.totalCents !== expectedTotalCents ||
        !approvesLines(request, lines)
      ) {
        throw orderChanged()
      }
      // Defensive: a revision's total is fixed while H1 holds.
      if (latest.amountCents !== order.totalCents) throw orderChanged()
      if (latest.stockHeld) return latest
      // Only attempts from before reservations existed can lack held stock.
      await decrementStock(tx, lines)
      const [held] = await tx
        .update(paymentAttempts)
        .set({ stockHeld: true, updatedAt: new Date() })
        .where(eq(paymentAttempts.id, latest.id))
        .returning()
      return held ?? latest
    }

    // A first execution, or the next one after a decline: plan from current
    // stock, locked, so the reservation below cannot come up short.
    const stock = await lockStock(tx, lines)
    const plan = planPartialPayment(lines, stock)
    // Pay errors go to the patient, so the quote carries no fee.
    const quote = partialPaymentQuoteDto(plan, 'patient')
    const stale =
      order.revision !== expectedRevision ||
      (mode === 'full' ? order.totalCents : quote.pay.totalCents) !==
        expectedTotalCents ||
      !approvesLines(request, plan.payLines)
    if (mode === 'full') {
      if (stale) throw orderChanged()
      if (plan.hasShortfall) throw insufficientStock(lines, stock, quote)
    } else {
      if (!plan.payable) {
        throw new ApiError(
          409,
          'AWAITING_STOCK',
          'Nothing on this order is in stock yet.',
        )
      }
      if (stale) throw orderChanged(quote)
    }
    // An order splits at most once: a reduced order that came up short again
    // (say, after a decline) can only be paid once restocked.
    if (plan.hasShortfall && (await findBackorder(tx, orderId))) {
      throw insufficientStock(lines, stock, quote)
    }
    const revision = plan.hasShortfall
      ? await splitOrder(tx, order, plan, expectedRevision)
      : order.revision
    const amountCents = plan.hasShortfall
      ? quote.pay.totalCents
      : order.totalCents

    // Reserve, then record. A first execution after a split starts at the new revision.
    await decrementStock(tx, plan.payLines)
    const execution =
      revision === order.revision ? (latest?.execution ?? 0) + 1 : 1
    const [created] = await tx
      .insert(paymentAttempts)
      .values({
        orderId,
        revision,
        execution,
        idempotencyKey: idempotencyKeyFor(orderId, revision, execution),
        amountCents,
        stockHeld: true,
      })
      .returning()
    if (!created) {
      throw new Error(
        `Payment attempt insert for order ${orderId} returned no row`,
      )
    }
    return created
  })
}

/**
 * Applies a gateway outcome to exactly the execution it belongs to (fenced):
 * only while that execution is still pending or in conflict. Returns the
 * attempt as it stands afterwards; a stale or duplicate outcome changes
 * nothing. A decline releases the reservation in the same transaction, and
 * only when its fenced update matched, so it can never release stock that a
 * newer execution or a success holds.
 */
async function applyOutcome(
  db: Db,
  attempt: Attempt,
  outcome:
    | { status: 'succeeded'; reference: string }
    | { status: 'declined' }
    | { status: 'conflict' },
): Promise<Attempt> {
  return db.transaction(async (tx) => {
    await lockOrder(tx, attempt.orderId)
    const fence = and(
      eq(paymentAttempts.id, attempt.id),
      eq(paymentAttempts.execution, attempt.execution),
      inArray(paymentAttempts.status, ['pending', 'conflict']),
    )
    const [applied] = await tx
      .update(paymentAttempts)
      .set({
        status: outcome.status,
        gatewayReference:
          outcome.status === 'succeeded' ? outcome.reference : null,
        stockHeld: outcome.status === 'declined' ? false : attempt.stockHeld,
        updatedAt: new Date(),
      })
      .where(fence)
      .returning()
    if (applied && outcome.status === 'declined' && attempt.stockHeld) {
      await releaseStock(tx, await loadPayLines(tx, attempt.orderId))
    }
    if (applied) return applied
    const [current] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id))
    if (!current) throw new Error(`Payment attempt ${attempt.id} disappeared`)
    return current
  })
}

/**
 * Steps 3 and 4 for a pending or conflicted execution: charge its key and apply
 * the outcome. The durable gateway gives concurrent calls for one key the
 * identical outcome, so a decline and a success can never both exist for it.
 */
async function chargeExecution(
  { db, gateway, allowSimulatedFailure }: AppContext,
  attempt: Attempt,
  simulateFailure: boolean,
): Promise<Attempt> {
  const charge = await gateway.charge({
    amountCents: attempt.amountCents,
    idempotencyKey: attempt.idempotencyKey,
    description: `Supplement order ${attempt.orderId} (revision ${attempt.revision}, execution ${attempt.execution})`,
    simulateFailure: allowSimulatedFailure && simulateFailure,
  })
  if (charge.status === 'succeeded') {
    if (charge.amountCents !== attempt.amountCents) {
      await applyOutcome(db, attempt, { status: 'conflict' })
      throw needsReconciliation()
    }
    const applied = await applyOutcome(db, attempt, {
      status: 'succeeded',
      reference: charge.reference,
    })
    if (
      applied.status !== 'succeeded' ||
      applied.gatewayReference !== charge.reference
    ) {
      throw needsReconciliation()
    }
    return applied
  }
  if (charge.failureMessage === IDEMPOTENCY_KEY_REUSED) {
    // Not a decline: something already holds this key at another amount, so
    // the outcome is unknown. Keep the reservation and block the order (N3).
    await applyOutcome(db, attempt, { status: 'conflict' })
    throw needsReconciliation()
  }
  const applied = await applyOutcome(db, attempt, { status: 'declined' })
  if (applied.status === 'succeeded') return applied
  throw new ApiError(
    402,
    'PAYMENT_FAILED',
    charge.failureMessage ?? 'Payment was declined',
  )
}

/**
 * Checks a succeeded execution against the gateway's record without charging
 * (N2): the gateway must hold a success for its key with the same amount and
 * reference. Anything else is left for reconciliation.
 */
async function verifySucceeded({ gateway }: AppContext, attempt: Attempt) {
  const found = await gateway.lookup(attempt.idempotencyKey)
  if (
    found?.status !== 'succeeded' ||
    found.amountCents !== attempt.amountCents ||
    found.reference !== attempt.gatewayReference
  ) {
    throw needsReconciliation()
  }
}

/**
 * Step 5 (one transaction): lock, re-check the order still matches the
 * succeeded execution, record the payment against it (its held stock becomes
 * the sale), post and verify its journal (revision 16), mark paid. If this rolls
 * back, the execution stays succeeded without a payment and blocks the order
 * until a retried pay finalizes it.
 */
async function recordPayment({ db, payHooks }: AppContext, attempt: Attempt) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(tx, attempt.orderId)
    if (order.status === 'paid' && order.revision === attempt.revision) return
    const [current] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id))
    if (
      current?.status !== 'succeeded' ||
      current.gatewayReference === null ||
      order.status !== 'pending_payment' ||
      order.revision !== current.revision ||
      order.totalCents !== current.amountCents
    ) {
      throw new Error(
        `Order ${order.id} no longer matches payment attempt ${attempt.id}`,
      )
    }
    const lines = await loadPayLines(tx, order.id)
    const split = computeSplit(lines)
    if (split.totalCents !== order.totalCents) {
      throw new Error(
        `Order ${order.id} lines no longer match the sent total (${split.totalCents} != ${order.totalCents})`,
      )
    }
    // The execution reserved the stock in step 1; take it now only if it holds none.
    if (!current.stockHeld) {
      await decrementStock(tx, lines)
      await tx
        .update(paymentAttempts)
        .set({ stockHeld: true, updatedAt: new Date() })
        .where(eq(paymentAttempts.id, current.id))
    }

    const [payment] = await tx
      .insert(payments)
      .values({
        orderId: order.id,
        amountCents: current.amountCents,
        idempotencyKey: current.idempotencyKey,
        gatewayReference: current.gatewayReference,
        paymentAttemptId: current.id,
      })
      .returning({ id: payments.id, amountCents: payments.amountCents })
    if (!payment)
      throw new Error(`Payment insert for order ${order.id} returned no row`)

    await postPaymentJournal(tx, {
      paymentId: payment.id,
      orderId: order.id,
      providerId: order.providerId,
      amountCents: payment.amountCents,
      split,
    })
    await payHooks.afterLedgerInsert?.()

    const now = new Date()
    await tx
      .update(orders)
      .set({ status: 'paid', paidAt: now, updatedAt: now })
      .where(eq(orders.id, order.id))
  })
}

/**
 * The money path (revision 10, DOMAIN_CONTRACT "execution-safe payments"):
 * validate the quote and pick or start an execution with its stock held;
 * charge it (or, for an execution already succeeded, verify it by lookup,
 * never by charging again); apply the outcome under a fence; then write
 * payment, journal and status atomically.
 */
export async function payOrder(
  ctx: AppContext,
  user: PatientUser,
  orderId: number,
  request: PayRequest,
) {
  const attempt = await preparePayment(ctx.db, user, orderId, request)
  if (attempt === null) return
  const succeeded =
    attempt.status === 'succeeded'
      ? attempt
      : await chargeExecution(ctx, attempt, request.simulateFailure)
  if (attempt.status === 'succeeded') await verifySucceeded(ctx, attempt)
  await recordPayment(ctx, succeeded)
}
