import {
  computeSplit,
  paymentJournalAccountOf,
  splitFromPostings,
  USER_ID_HEADER,
  type DraftLine,
  type OrderLineInput,
  type PaymentJournalAccount,
} from '@supplement-orders/domain'
import { asc, eq, sql } from 'drizzle-orm'
import { expect } from 'vitest'
import type { Db } from '../db/client'
import {
  accounts,
  journals,
  orders,
  payments,
  postings,
  products,
} from '../db/schema'
import type { InternalTestContext, TestContext } from './harness'

export function as(userId: number) {
  return { [USER_ID_HEADER]: String(userId) }
}

export interface CompleteLine extends DraftLine {
  productId: number
  unitPriceCents: number
}

/** Two complete lines priced well above their minimums, from the first two seeded products. */
export function sampleLines(ctx: TestContext): CompleteLine[] {
  const [a, b] = ctx.seed.products
  return [
    { productId: a!.id, quantity: 2, unitPriceCents: a!.cogsCents + 1000 },
    { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents + 333 },
  ]
}

export async function createDraft(
  ctx: TestContext,
  lines: OrderLineInput[] = sampleLines(ctx),
) {
  const created = await ctx.request
    .post('/api/orders')
    .set(as(ctx.seed.providerUserId))
    .send({ patientId: ctx.seed.patientId })
  expect(created.status).toBe(201)
  const orderId: number = created.body.id
  const put = await ctx.request
    .put(`/api/orders/${orderId}/lines`)
    .set(as(ctx.seed.providerUserId))
    .send({ lines })
  expect(put.status).toBe(200)
  return orderId
}

export async function createSentOrder(
  ctx: TestContext,
  lines: OrderLineInput[] = sampleLines(ctx),
) {
  const orderId = await createDraft(ctx, lines)
  const sent = await ctx.request
    .post(`/api/orders/${orderId}/send`)
    .set(as(ctx.seed.providerUserId))
  expect(sent.status).toBe(200)
  return orderId
}

/**
 * The quote the patient is looking at, read the way the pay screen reads it.
 * Falls back to a placeholder quote when the patient can't see the order, so
 * tests of 403/404 paths still send a well-formed body.
 */
export async function patientQuote(ctx: TestContext, orderId: number) {
  const res = await ctx.request
    .get(`/api/orders/${orderId}`)
    .set(as(ctx.seed.patientUserId))
  if (res.status !== 200) return { expectedRevision: 1, expectedTotalCents: 0 }
  return {
    expectedRevision: res.body.revision as number,
    expectedTotalCents: res.body.totalCents as number,
  }
}

/**
 * Pays as the patient with the quote they currently see (revision 9). Fields in
 * `body` override it, e.g. a stale expectedTotalCents or simulateFailure.
 */
export async function pay(
  ctx: TestContext,
  orderId: number,
  body: object = {},
) {
  const quote = await patientQuote(ctx, orderId)
  return ctx.request
    .post(`/api/orders/${orderId}/pay`)
    .set(as(ctx.seed.patientUserId))
    .send({ ...quote, ...body })
}

/** Everything the pay transaction may touch, read straight from the database. */
export async function moneyState(ctx: InternalTestContext, orderId: number) {
  const [order] = await ctx.db
    .select({ status: orders.status, paidAt: orders.paidAt })
    .from(orders)
    .where(eq(orders.id, orderId))
  return {
    order,
    payments: await ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId)),
    journals: await ctx.db
      .select()
      .from(journals)
      .where(eq(journals.orderId, orderId)),
    /** Revision 16: the order's postings in posting order, with their account. */
    postings: await ctx.db
      .select({
        id: postings.id,
        journalId: postings.journalId,
        paymentId: journals.paymentId,
        accountCode: accounts.code,
        accountProviderId: accounts.providerId,
        amountCents: postings.amountCents,
      })
      .from(postings)
      .innerJoin(journals, eq(journals.id, postings.journalId))
      .innerJoin(accounts, eq(accounts.id, postings.accountId))
      .where(eq(journals.orderId, orderId))
      .orderBy(asc(postings.id)),
    stock: await ctx.db
      .select({ id: products.id, stockQuantity: products.stockQuantity })
      .from(products)
      .orderBy(products.id),
  }
}

/** The split computeSplit gives for complete lines of seeded products. */
export function expectedSplit(ctx: TestContext, lines: CompleteLine[]) {
  return computeSplit(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      unitCogsCents: ctx.seed.products.find((p) => p.id === line.productId)!
        .cogsCents,
    })),
  )
}

interface PostingLike {
  accountCode: string
  accountProviderId: number | null
  amountCents: number
}

/** Revision 16: which line of a patient payment a moneyState posting is. */
export function postingRole(posting: PostingLike): PaymentJournalAccount {
  const role = paymentJournalAccountOf(posting.accountCode)
  if (!role) throw new Error(`Unexpected account ${posting.accountCode}`)
  return role
}

/**
 * Revision 16: the split a payment journal's postings record. Also asserts the
 * postings balance, so callers check both at once.
 */
export function journalSplitOf(postingRows: PostingLike[]) {
  expect(postingRows.reduce((sum, p) => sum + p.amountCents, 0)).toBe(0)
  postingRows.forEach(postingRole)
  return splitFromPostings(postingRows)
}

/**
 * Test fixtures only: writes a payment's journal by direct SQL, the way a
 * legacy or hand-built payment would have it: Cash debit, then credits for
 * cogs, the order's provider payable and the fee, zero amounts omitted. Amounts
 * are text so values past 2^53 stay exact.
 */
export async function insertPaymentJournal(
  tx: Pick<Db, 'execute'>,
  input: {
    paymentId: number
    orderId: number
    cogsCents: number | string
    marginCents: number | string
    feeCents: number | string
  },
) {
  const journal = await tx.execute<{ id: number }>(sql`
    insert into journals (kind, payment_id, order_id, memo)
    values ('patient_payment', ${input.paymentId}, ${input.orderId}, ${`Patient payment for order #${input.orderId}`})
    returning id`)
  const journalId = journal.rows[0]!.id
  await tx.execute(sql`
    insert into postings (journal_id, account_id, amount_cents)
    select ${journalId}, a.id, x.amount
    from (values
      (1, '1000', (select amount_cents from payments where id = ${input.paymentId})),
      (2, '4000', -(${String(input.cogsCents)}::bigint)),
      (3, (select '2100-' || provider_id from orders where id = ${input.orderId}), -(${String(input.marginCents)}::bigint)),
      (4, '4100', -(${String(input.feeCents)}::bigint))
    ) as x(position, code, amount)
    join accounts a on a.code = x.code
    where x.amount <> 0
    order by x.position`)
  return journalId
}

/**
 * Test fixtures only: a succeeded payment attempt for the order's current
 * revision, the provenance migration 0015 requires of every payment.
 */
export async function insertSucceededAttempt(
  tx: Pick<Db, 'execute'>,
  input: { orderId: number; amountCents: number | string; key: string },
) {
  const attempt = await tx.execute<{ id: number }>(sql`
    insert into payment_attempts (order_id, revision, execution, idempotency_key, amount_cents, status, gateway_reference, stock_held)
    select id, revision, 1 + (select count(*) from payment_attempts where order_id = ${input.orderId}),
      ${input.key}, ${String(input.amountCents)}::bigint, 'succeeded', ${`ref-${input.key}`}, true
    from orders where id = ${input.orderId}
    returning id`)
  return attempt.rows[0]!.id
}

/** Stock is read-only over HTTP, so tests set it directly. */
export async function setStock(
  ctx: InternalTestContext,
  productId: number,
  stockQuantity: number,
) {
  await ctx.db
    .update(products)
    .set({ stockQuantity })
    .where(eq(products.id, productId))
}

type FixtureTx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Test fixtures only: runs `write` with migration 0013's paid-order freeze
 * switched off for this one transaction, e.g. to pin a paid order's paid_at.
 * The application never does this; ALTER TABLE is transactional, so the
 * trigger is back on for everyone the moment this commits or rolls back.
 */
export async function withPaidOrdersUnfrozen<T>(
  db: Db,
  write: (tx: FixtureTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`alter table orders disable trigger orders_paid_frozen`)
    await tx.execute(
      sql`alter table order_items disable trigger order_items_paid_frozen`,
    )
    const result = await write(tx)
    await tx.execute(sql`alter table orders enable trigger orders_paid_frozen`)
    await tx.execute(
      sql`alter table order_items enable trigger order_items_paid_frozen`,
    )
    return result
  })
}
