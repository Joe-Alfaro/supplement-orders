import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

// Money columns are bigint cents read back as JS numbers. Every value we store is
// bounded by Number.MAX_SAFE_INTEGER because computeSplit rejects anything larger.
function cents(name: string) {
  return bigint(name, { mode: 'number' })
}

function createdAt() {
  return timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}

export const roleEnum = pgEnum('role', ['provider', 'patient'])

export const orderStatusEnum = pgEnum('order_status', [
  'draft',
  'pending_payment',
  'paid',
  'cancelled',
])

export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'cogs',
  'provider_margin',
  'platform_fee',
])

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
    // Set when a provider cancels a pending order. No ledger or stock effect.
    // Revision 6 also allowed cancelling drafts; such rows may still exist.
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
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
  ],
)

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
    createdAt: createdAt(),
  },
  (t) => [check('payments_amount_nonnegative', sql`${t.amountCents} >= 0`)],
)

// Append-only: the application has no update or delete path for this table.
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    paymentId: integer('payment_id')
      .notNull()
      .references(() => payments.id),
    type: ledgerEntryTypeEnum('type').notNull(),
    amountCents: cents('amount_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ledger_entries_payment_type_unique').on(t.paymentId, t.type),
    check('ledger_entries_amount_nonnegative', sql`${t.amountCents} >= 0`),
  ],
)
