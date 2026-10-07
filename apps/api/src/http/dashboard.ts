import {
  calendarDayInZone,
  dashboardQuerySchema,
  resolveDashboardRange,
  type DashboardDto,
} from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { Router } from 'express'
import { ledgerEntries, orders, payments } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { ApiError } from './errors'
import { parseOrThrow } from './validate'

interface DashboardRow extends Record<string, unknown> {
  gmv_cents: string
  provider_margin_cents: string
  platform_fee_cents: string
}

/**
 * Sums arrive as exact decimal text. Anything beyond Number.MAX_SAFE_INTEGER
 * would round silently as a JS number, so it is refused rather than reported.
 */
function exactCents(value: string, field: string) {
  const cents = BigInt(value)
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiError(
      500,
      'INTERNAL',
      `Dashboard ${field} exceeds the exact cent range`,
    )
  }
  return Number(cents)
}

/**
 * GMV is what patients actually paid (payments); margin and fees come from the
 * ledger, so the dashboard reports the audited figures rather than recomputing
 * them. All three are read in one statement, so they describe one snapshot even
 * while payments commit concurrently (revision 9, M4). The server resolves the
 * requested range to calendar days in the caller's zone (revision 11a-v2) and
 * bounds all three on orders.paid_at to [local midnight of the first day, local
 * midnight of the day after the last); Postgres computes those instants, so a
 * 23- or 25-hour DST day is handled.
 */
export function dashboardRouter({ db, auth, now }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const query = parseOrThrow(dashboardQuerySchema, req.query)
    const range = resolveDashboardRange(
      query,
      calendarDayInZone(now(), query.timeZone),
    )
    const { from, to, timeZone } = range
    const paid = sql`${orders.providerId} = ${user.providerId} and ${orders.status} = 'paid'
      and (${from}::text is null
           or ${orders.paidAt} >= (${from}::text::date)::timestamp at time zone ${timeZone}::text)
      and (${to}::text is null
           or ${orders.paidAt} < (${to}::text::date + 1)::timestamp at time zone ${timeZone}::text)`
    const result = await db.execute<DashboardRow>(sql`
      select
        (select coalesce(sum(${payments.amountCents}), 0)::text
           from ${payments} join ${orders} on ${orders.id} = ${payments.orderId}
          where ${paid}) as gmv_cents,
        (select coalesce(sum(${ledgerEntries.amountCents}), 0)::text
           from ${ledgerEntries} join ${orders} on ${orders.id} = ${ledgerEntries.orderId}
          where ${paid} and ${ledgerEntries.type} = 'provider_margin') as provider_margin_cents,
        (select coalesce(sum(${ledgerEntries.amountCents}), 0)::text
           from ${ledgerEntries} join ${orders} on ${orders.id} = ${ledgerEntries.orderId}
          where ${paid} and ${ledgerEntries.type} = 'platform_fee') as platform_fee_cents
    `)
    const [row] = result.rows
    if (!row) throw new Error('Dashboard query returned no row')

    const body: DashboardDto = {
      gmvCents: exactCents(row.gmv_cents, 'GMV'),
      providerMarginCents: exactCents(row.provider_margin_cents, 'margin'),
      platformFeeCents: exactCents(row.platform_fee_cents, 'processing fees'),
      range,
    }
    res.json(body)
  })

  return router
}
