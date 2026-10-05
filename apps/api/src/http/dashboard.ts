import type { DashboardDto } from '@supplement-orders/domain'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { ledgerEntries, orders, patients, payments, users } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'

function sumOfType(type: 'cogs' | 'provider_margin' | 'platform_fee') {
  return sql<number>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.type} = ${type}), 0)`.mapWith(
    Number,
  )
}

/**
 * GMV is what patients actually paid (payments); margin and fees come from the
 * ledger, so the dashboard reports the audited figures rather than recomputing them.
 */
export function dashboardRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const paidByProvider = and(
      eq(orders.providerId, user.providerId),
      eq(orders.status, 'paid'),
    )

    const [gmv] = await db
      .select({
        gmvCents:
          sql<number>`coalesce(sum(${payments.amountCents}), 0)`.mapWith(
            Number,
          ),
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(paidByProvider)

    const [ledgerTotals] = await db
      .select({
        providerMarginCents: sumOfType('provider_margin'),
        platformFeeCents: sumOfType('platform_fee'),
      })
      .from(ledgerEntries)
      .innerJoin(orders, eq(orders.id, ledgerEntries.orderId))
      .where(paidByProvider)

    const paidOrders = await db
      .select({
        orderId: orders.id,
        patientId: orders.patientId,
        patientName: users.name,
        paidAt: orders.paidAt,
        totalCents: payments.amountCents,
        cogsCents: sumOfType('cogs'),
        providerMarginCents: sumOfType('provider_margin'),
        platformFeeCents: sumOfType('platform_fee'),
      })
      .from(orders)
      .innerJoin(payments, eq(payments.orderId, orders.id))
      .innerJoin(ledgerEntries, eq(ledgerEntries.paymentId, payments.id))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .innerJoin(users, eq(users.id, patients.userId))
      .where(paidByProvider)
      .groupBy(orders.id, users.name, payments.id)
      .orderBy(desc(orders.paidAt), desc(orders.id))

    const body: DashboardDto = {
      gmvCents: gmv?.gmvCents ?? 0,
      providerMarginCents: ledgerTotals?.providerMarginCents ?? 0,
      platformFeeCents: ledgerTotals?.platformFeeCents ?? 0,
      paidOrders: paidOrders.map((o) => ({
        ...o,
        paidAt: (o.paidAt ?? new Date(0)).toISOString(),
      })),
    }
    res.json(body)
  })

  return router
}
