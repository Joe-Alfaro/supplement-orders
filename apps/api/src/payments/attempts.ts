import type {
  AdminPaymentAttemptDto,
  AdminPaymentAttemptFilter,
  AdminPaymentAttemptPageDto,
} from '@supplement-orders/domain'
import { and, asc, count, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  orders,
  paymentAttempts,
  payments,
  providers,
  users,
} from '../db/schema'

/**
 * Revision 18.2: an attempt is unresolved while it is pending, in conflict, or
 * succeeded without a payment. The same rule as assertNoUnreconciledCharge.
 */
const unresolved = and(
  or(
    inArray(paymentAttempts.status, ['pending', 'conflict']),
    eq(paymentAttempts.status, 'succeeded'),
  ),
  isNull(payments.id),
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
  }
}

/**
 * GET /api/admin/payment-attempts: `unresolved` lists the attempts needing
 * attention, oldest first; `all` lists every attempt, newest first, so the
 * outcome of each reconcile stays visible.
 */
export async function listPaymentAttempts(
  db: Db,
  now: Date,
  {
    status,
    offset,
    limit,
  }: { status: AdminPaymentAttemptFilter; offset: number; limit: number },
): Promise<AdminPaymentAttemptPageDto> {
  const where = status === 'unresolved' ? unresolved : undefined
  const ordering =
    status === 'unresolved'
      ? [asc(paymentAttempts.createdAt), asc(paymentAttempts.id)]
      : [desc(paymentAttempts.createdAt), desc(paymentAttempts.id)]
  const [rows, [counted]] = await Promise.all([
    selectAttempts(db)
      .where(where)
      .orderBy(...ordering)
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(paymentAttempts)
      .leftJoin(payments, eq(payments.paymentAttemptId, paymentAttempts.id))
      .where(where),
  ])
  return {
    items: rows.map((row) => toDto(row, now)),
    total: counted?.total ?? 0,
    offset,
    limit,
  }
}

/** One attempt as the admin sees it, or undefined when there is none. */
export async function findPaymentAttempt(db: Db, now: Date, id: number) {
  const [row] = await selectAttempts(db).where(eq(paymentAttempts.id, id))
  return row === undefined ? undefined : toDto(row, now)
}
