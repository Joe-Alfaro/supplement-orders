import {
  ACCOUNT_TYPES,
  JOURNAL_KINDS,
  NORMAL_BALANCES,
  ORDER_STATUSES,
} from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  pgView,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// Money columns are bigint cents read back as JS numbers. Every value we store is
// bounded by Number.MAX_SAFE_INTEGER because computeSplit rejects anything larger.
function cents(name: string) {
  return bigint(name, { mode: 'number' })
}

function createdAt() {
  return timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}

// Revision 13 adds admin: no provider or patient profile; manages stock.
export const roleEnum = pgEnum('role', ['provider', 'patient', 'admin'])

export const orderStatusEnum = pgEnum('order_status', [
  'draft',
  'pending_payment',
  'paid',
  'cancelled',
])

/**
 * Revision 10: pending = stock held, gateway outcome unknown; succeeded = the
 * gateway charged it; declined = the gateway refused it and the stock was
 * released; conflict = the key is bound to another amount at the gateway, so
 * the outcome is unresolved and the stock stays held.
 */
export const paymentAttemptStatusEnum = pgEnum('payment_attempt_status', [
  'pending',
  'succeeded',
  'declined',
  'conflict',
])

export const fakeGatewayChargeStatusEnum = pgEnum(
  'fake_gateway_charge_status',
  ['succeeded', 'declined'],
)

/**
 * Revision 10: the fake payment gateway's own durable store, standing in for
 * an external processor's idempotency records. Written only by
 * FakePaymentGateway, each in its own committed statement and never inside the
 * API's payment transactions. The first call for a key decides its outcome.
 */
export const fakeGatewayCharges = pgTable(
  'fake_gateway_charges',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    amountCents: cents('amount_cents').notNull(),
    status: fakeGatewayChargeStatusEnum('status').notNull(),
    reference: text('reference').unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'fake_gateway_charges_reference_iff_succeeded',
      sql`(${t.status} = 'succeeded') = (${t.reference} is not null)`,
    ),
    check(
      'fake_gateway_charges_amount_nonnegative',
      sql`${t.amountCents} >= 0`,
    ),
  ],
)

// List endpoints order by (name, id) and search with `column ILIKE '%q%'`. The
// (name, id) btree serves ordering and pagination. A btree can't serve a
// substring match, so each searched column also has a pg_trgm GIN index on the
// bare column (migration 0005 creates the extension). The queries must keep
// ILIKE on the bare column, not lower(column), or these indexes stop matching.
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    role: roleEnum('role').notNull(),
  },
  (t) => [
    index('users_name_id_idx').on(t.name, t.id),
    index('users_lower_name_idx').on(sql`lower(${t.name})`),
    index('users_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
  ],
)

export const providers = pgTable('providers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
})

export const patients = pgTable(
  'patients',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id),
    // With the name, how clinicians identify a patient. Read back as 'YYYY-MM-DD'.
    dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
    address: text('address').notNull(),
  },
  (t) => [index('patients_provider_id_idx').on(t.providerId)],
)

export const products = pgTable(
  'products',
  {
    id: serial('id').primaryKey(),
    sku: text('sku').notNull().unique(),
    name: text('name').notNull(),
    cogsCents: cents('cogs_cents').notNull(),
    stockQuantity: integer('stock_quantity').notNull(),
  },
  (t) => [
    check('products_cogs_nonnegative', sql`${t.cogsCents} >= 0`),
    check('products_stock_nonnegative', sql`${t.stockQuantity} >= 0`),
    index('products_name_id_idx').on(t.name, t.id),
    index('products_lower_name_idx').on(sql`lower(${t.name})`),
    index('products_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('products_sku_trgm_idx').using('gin', t.sku.op('gin_trgm_ops')),
  ],
)

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id),
    patientId: integer('patient_id')
      .notNull()
      .references(() => patients.id),
    status: orderStatusEnum('status').notNull().default('draft'),
    // Snapshot of the split taken on send; null while the order is a draft.
    subtotalCents: cents('subtotal_cents'),
    platformFeeCents: cents('platform_fee_cents'),
    totalCents: cents('total_cents'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    // Set when a provider cancels a pending order. No journal or stock effect.
    // Revision 6 also allowed cancelling drafts; such rows may still exist.
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // Revision 9: the quote version. 0 until first sent, +1 on every send.
    revision: integer('revision').notNull().default(0),
    // Revision 14: a back-order points at the order it was split from, and at
    // that order's revision whose quote produced the split (replay detection).
    splitFromOrderId: integer('split_from_order_id').references(
      (): AnyPgColumn => orders.id,
    ),
    splitFromRevision: integer('split_from_revision'),
  },
  (t) => [
    check(
      'orders_totals_present_once_sent',
      sql`${t.sentAt} is null or (${t.subtotalCents} is not null and ${t.platformFeeCents} is not null and ${t.totalCents} is not null)`,
    ),
    // Only drafts and drafts cancelled before sending lack sentAt.
    check(
      'orders_sent_unless_draft_or_cancelled',
      sql`${t.status} in ('draft', 'cancelled') or ${t.sentAt} is not null`,
    ),
    check(
      'orders_cancelled_at_iff_cancelled',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check(
      'orders_revision_counts_sends',
      sql`${t.revision} >= 0 and (${t.sentAt} is null or ${t.revision} >= 1)`,
    ),
    // Dashboard "Awaiting payment": one provider's pending orders, oldest first.
    // Revision 8: patients' latest-order filter (latest by created_at, then id).
    index('orders_patient_created_idx').on(
      t.patientId,
      sql`${t.createdAt} desc`,
      sql`${t.id} desc`,
    ),
    // Revision 8 Orders tab: most recent activity first, per status and for "all".
    // The expression must match orderActivityAt in orders/views.ts. Plain DESC
    // (nulls first) to match ORDER BY ... DESC; .desc() would add NULLS LAST.
    index('orders_provider_status_activity_idx').on(
      t.providerId,
      t.status,
      sql`coalesce(${t.paidAt}, ${t.cancelledAt}, ${t.sentAt}, ${t.createdAt}) desc`,
      sql`${t.id} desc`,
    ),
    index('orders_provider_activity_idx').on(
      t.providerId,
      sql`coalesce(${t.paidAt}, ${t.cancelledAt}, ${t.sentAt}, ${t.createdAt}) desc`,
      sql`${t.id} desc`,
    ),
    index('orders_provider_status_sent_idx').on(
      t.providerId,
      t.status,
      t.sentAt,
      t.id,
    ),
    // Revision 2: the fee comes out of the provider's markup; the patient pays the subtotal.
    check(
      'orders_total_is_subtotal',
      sql`${t.totalCents} is null or ${t.totalCents} = ${t.subtotalCents}`,
    ),
    check(
      'orders_fee_within_subtotal',
      sql`${t.platformFeeCents} is null or ${t.platformFeeCents} <= ${t.subtotalCents}`,
    ),
    check(
      'orders_paid_at_iff_paid',
      sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`,
    ),
    // Revision 14: each order has at most one direct back-order.
    uniqueIndex('orders_split_from_order_id_unique').on(t.splitFromOrderId),
    check(
      'orders_split_columns_together',
      sql`(${t.splitFromOrderId} is null) = (${t.splitFromRevision} is null)`,
    ),
  ],
)

/**
 * Revision 14 (DOMAIN_CONTRACT 14.3b): every orders column plus the derived
 * `effective_status`, defined by migration 0012. Order reads (lists, detail,
 * filters, the patient's latest status) select from here; writes and row
 * locks always target `orders`.
 */
export const ordersWithStatus = pgView('orders_with_status', {
  id: integer('id').notNull(),
  providerId: integer('provider_id').notNull(),
  patientId: integer('patient_id').notNull(),
  status: orderStatusEnum('status').notNull(),
  subtotalCents: cents('subtotal_cents'),
  platformFeeCents: cents('platform_fee_cents'),
  totalCents: cents('total_cents'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  revision: integer('revision').notNull(),
  splitFromOrderId: integer('split_from_order_id'),
  splitFromRevision: integer('split_from_revision'),
  effectiveStatus: text('effective_status', {
    enum: ORDER_STATUSES,
  }).notNull(),
}).existing()

// Draft lines may be incomplete (no product or no price yet). Completeness of
// sent orders is enforced by the send service, which is the only path out of draft.
export const orderItems = pgTable(
  'order_items',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: integer('product_id').references(() => products.id),
    quantity: integer('quantity').notNull(),
    unitPriceCents: cents('unit_price_cents'),
    unitCogsCents: cents('unit_cogs_cents'),
    // Revision 15.5: the product's name and SKU, snapshotted when the line is
    // saved and refreshed on send, so a sent or paid order keeps what was sold.
    productName: text('product_name'),
    productSku: text('product_sku'),
  },
  (t) => [
    // Postgres treats NULLs as distinct, so several product-less lines may coexist.
    unique('order_items_order_product_unique').on(t.orderId, t.productId),
    check('order_items_quantity_positive', sql`${t.quantity} >= 1`),
    check('order_items_price_nonnegative', sql`${t.unitPriceCents} >= 0`),
    check('order_items_cogs_nonnegative', sql`${t.unitCogsCents} >= 0`),
    check(
      'order_items_cogs_iff_product',
      sql`(${t.productId} is null) = (${t.unitCogsCents} is null)`,
    ),
    check(
      'order_items_snapshot_iff_product',
      sql`(${t.productId} is null) = (${t.productName} is null) and (${t.productId} is null) = (${t.productSku} is null)`,
    ),
  ],
)

/**
 * Revision 9: one row per (order, revision) quote, committed before the gateway
 * is called and updated with its result in a separate transaction, so a charge
 * that outlives a rolled-back payment write is never lost. A succeeded attempt
 * without a payment row is an unreconciled charge.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    revision: integer('revision').notNull(),
    /** Revision 10: 1, 2, ... per (order, revision); a new one only after a decline. */
    execution: integer('execution').notNull().default(1),
    /** order-<id>-r<revision>-e<execution> (attempts before revision 10 keep order-<id>-r<revision>). */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    amountCents: cents('amount_cents').notNull(),
    status: paymentAttemptStatusEnum('status').notNull().default('pending'),
    gatewayReference: text('gateway_reference'),
    /**
     * True while this attempt holds the order's stock: reserved with the attempt
     * (before any charge), released if the charge fails, and kept as the sale
     * once the payment is recorded. An unreconciled charge keeps its stock.
     */
    stockHeld: boolean('stock_held').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('payment_attempts_order_revision_execution_unique').on(
      t.orderId,
      t.revision,
      t.execution,
    ),
    check('payment_attempts_execution_positive', sql`${t.execution} >= 1`),
    check('payment_attempts_amount_nonnegative', sql`${t.amountCents} >= 0`),
    check(
      'payment_attempts_reference_iff_succeeded',
      sql`(${t.status} = 'succeeded') = (${t.gatewayReference} is not null)`,
    ),
  ],
)

export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id')
      .notNull()
      .unique()
      .references(() => orders.id),
    amountCents: cents('amount_cents').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    gatewayReference: text('gateway_reference').notNull(),
    // Revision 9. Null only for payments recorded before attempts existed.
    paymentAttemptId: integer('payment_attempt_id')
      .unique()
      .references(() => paymentAttempts.id),
    createdAt: createdAt(),
  },
  (t) => [check('payments_amount_nonnegative', sql`${t.amountCents} >= 0`)],
)

export const accountTypeEnum = pgEnum('account_type', ACCOUNT_TYPES)
export const normalBalanceEnum = pgEnum('normal_balance', NORMAL_BALANCES)
export const journalKindEnum = pgEnum('journal_kind', JOURNAL_KINDS)

/**
 * Revision 16: the chart of accounts. Migration 0014 seeds the system accounts
 * (1000 Cash, 4000 Product sales, 4100 Platform fee revenue) and a trigger on
 * `providers` creates each provider's `2100-<providerId>` payable. Append-only
 * except for a rename (migration 0014 triggers).
 */
export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    normalBalance: normalBalanceEnum('normal_balance').notNull(),
    providerId: integer('provider_id')
      .unique()
      .references(() => providers.id),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'accounts_normal_balance_matches_type',
      sql`(${t.type} = 'asset') = (${t.normalBalance} = 'debit')`,
    ),
    check(
      'accounts_provider_payable_is_liability',
      sql`${t.providerId} is null or ${t.type} = 'liability'`,
    ),
  ],
)

/**
 * Revision 16: one balanced set of postings. A patient_payment journal belongs
 * to exactly one payment (deferred triggers in migration 0014 check its
 * postings at commit). Append-only.
 */
export const journals = pgTable(
  'journals',
  {
    id: serial('id').primaryKey(),
    kind: journalKindEnum('kind').notNull(),
    paymentId: integer('payment_id')
      .unique()
      .references(() => payments.id),
    orderId: integer('order_id').references(() => orders.id),
    memo: text('memo').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'journals_patient_payment_links',
      sql`${t.kind} <> 'patient_payment' or (${t.paymentId} is not null and ${t.orderId} is not null)`,
    ),
    index('journals_order_id_idx').on(t.orderId),
    index('journals_posted_at_id_idx').on(
      sql`${t.postedAt} desc`,
      sql`${t.id} desc`,
    ),
  ],
)

/**
 * Revision 16: signed integer cents, positive = debit, negative = credit, never
 * 0 (checked at commit with the journal's balance). Append-only.
 */
export const postings = pgTable(
  'postings',
  {
    id: serial('id').primaryKey(),
    journalId: integer('journal_id')
      .notNull()
      .references(() => journals.id),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    amountCents: cents('amount_cents').notNull(),
  },
  (t) => [
    unique('postings_journal_account_unique').on(t.journalId, t.accountId),
    index('postings_account_id_idx').on(t.accountId),
  ],
)

export const inventoryAdjustmentKindEnum = pgEnum('inventory_adjustment_kind', [
  'increment',
  'set',
])

/**
 * Revision 13: one row per successful admin stock change, written in the same
 * transaction as the change. Append-only (migration 0011 rejects UPDATE and
 * DELETE). Payment reservations and releases are not recorded here.
 */
export const inventoryAdjustments = pgTable(
  'inventory_adjustments',
  {
    id: serial('id').primaryKey(),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    kind: inventoryAdjustmentKindEnum('kind').notNull(),
    previousQuantity: integer('previous_quantity').notNull(),
    newQuantity: integer('new_quantity').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_adjustments_product_id_idx').on(t.productId),
    check(
      'inventory_adjustments_quantities_nonnegative',
      sql`${t.previousQuantity} >= 0 and ${t.newQuantity} >= 0`,
    ),
  ],
)
