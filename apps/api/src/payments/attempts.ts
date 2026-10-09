import type {
  AdminPaymentAttemptDto,
  AdminPaymentAttemptFilter,
} from '@supplement-orders/domain'
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { BLOCKING_STATUSES } from '../orders/service'
import {
  orders,
  paymentAttempts,
  payments,
  providers,
  users,
} from '../db/schema'

/**
 * Revision 18.2: an attempt is unresolved while it blocks its order without a
 * payment (the rule of assertNoUnreconciledCharge): pending, in conflict,
 * succeeded, or (revision 19.1) a late success. A refund_required charge also
 * stays listed until it is marked refunded.
 */
const unresolved = or(
  and(inArray(paymentAttempts.status, BLOCKING_STATUSES), isNull(payments.id)),
  and(
    eq(paymentAttempts.status, 'refund_required'),
    isNull(paymentAttempts.refundedAt),
  ),
)

function selectAttempts(db: Db) {
  return db
    .select({
      id: paymentAttempts.id,
      orderId: paymentAttempts.orderId,
      providerName: users.name,
      amountCents: paymentAttempts.amountCents,
      status: paymentAttempts.status,
      paymentId: payments.id,
      createdAt: paymentAttempts.createdAt,
      reconciledAt: paymentAttempts.reconciledAt,
      gatewayReference: paymentAttempts.gatewayReference,
      refundedAt: paymentAttempts.refundedAt,
    })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .innerJoin(providers, eq(providers.id, orders.providerId))
    .innerJoin(users, eq(users.id, providers.userId))
    .leftJoin(payments, eq(payments.paymentAttemptId, paymentAttempts.id))
}

type AttemptRow = Awaited<ReturnType<typeof selectAttempts>>[number]

/** The admin's view of an attempt: no patient fields, age on the app's clock. */
function toDto(row: AttemptRow, now: Date): AdminPaymentAttemptDto {
  return {
    id: row.id,
    orderId: row.orderId,
    providerName: row.providerName,
    amountCents: row.amountCents,
    status: row.status,
    hasPayment: row.paymentId !== null,
    createdAt: row.createdAt.toISOString(),
    ageSeconds: Math.max(
      0,
      Math.floor((now.getTime() - row.createdAt.getTime()) / 1000),
    ),
    reconciledAt:
      row.reconciledAt === null ? null : row.reconciledAt.toISOString(),
    gatewayReference: row.gatewayReference,
    refundedAt: row.refundedAt === null ? null : row.refundedAt.toISOString(),
  }
}

/**
 * GET /api/admin/payment-attempts, a plain array: `unresolved` lists the
 * attempts needing attention, oldest first; `all` lists every attempt, newest
 * first, so the outcome of each reconcile stays visible. Unresolved attempts
 * are few by nature (each blocks its order), so the list isn't paged.
 */
export async function listPaymentAttempts(
  db: Db,
  now: Date,
  status: AdminPaymentAttemptFilter,
): Promise<AdminPaymentAttemptDto[]> {
  const rows =
    status === 'unresolved'
      ? await selectAttempts(db)
          .where(unresolved)
          .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.id))
      : await selectAttempts(db).orderBy(
          desc(paymentAttempts.createdAt),
          desc(paymentAttempts.id),
        )
  return rows.map((row) => toDto(row, now))
}

/** One attempt as the admin sees it, or undefined when there is none. */
export async function findPaymentAttempt(db: Db, now: Date, id: number) {
  const [row] = await selectAttempts(db).where(eq(paymentAttempts.id, id))
  return row === undefined ? undefined : toDto(row, now)
}
