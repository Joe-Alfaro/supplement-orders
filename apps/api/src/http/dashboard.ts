import {
  calendarDayInZone,
  dashboardQuerySchema,
  resolveDashboardRange,
  SYSTEM_ACCOUNTS,
  type DashboardDto,
} from '@supplement-orders/domain'
import { sql, type SQL } from 'drizzle-orm'
import { Router } from 'express'
import { accounts, journals, orders, postings } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { ApiError } from './errors'
import { parseOrThrow } from './validate'

interface DashboardRow extends Record<string, unknown> {
  gmv_cents: string
  provider_margin_cents: string
  platform_fee_cents: string
  owed_to_you_cents: string
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
 * Revision 16: every figure comes from postings on this provider's payment
 * journals: GMV is their Cash debits, margin their credits to the provider's
 * payable, and fees their Platform fee revenue credits. Owed to you is the
 * payable's balance, all time. All four are read in one statement, so they
 * describe one snapshot even while payments commit concurrently (revision 9,
 * M4). The server resolves the requested range to calendar days in the
 * caller's zone (revision 11a-v2) and bounds the three ranged figures on
 * orders.paid_at to [local midnight of the first day, local
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
    // This provider's payment journals whose order was paid in range.
    const inRange = sql`${postings.journalId} in (
      select ${journals.id} from ${journals}
        join ${orders} on ${orders.id} = ${journals.orderId}
       where ${journals.kind} = 'patient_payment' and ${paid})`
    const payable = sql`${accounts.providerId} = ${user.providerId}`
    const sumPostings = (where: SQL, sign: '' | '-') =>
      sql`(select coalesce(${sql.raw(sign)}sum(${postings.amountCents}), 0)::text
             from ${postings} join ${accounts} on ${accounts.id} = ${postings.accountId}
            where ${where})`
    const result = await db.execute<DashboardRow>(sql`
      select
        ${sumPostings(sql`${accounts.code} = ${SYSTEM_ACCOUNTS.cash.code} and ${postings.amountCents} > 0 and ${inRange}`, '')} as gmv_cents,
        ${sumPostings(sql`${payable} and ${postings.amountCents} < 0 and ${inRange}`, '-')} as provider_margin_cents,
        ${sumPostings(sql`${accounts.code} = ${SYSTEM_ACCOUNTS.platformFee.code} and ${postings.amountCents} < 0 and ${inRange}`, '-')} as platform_fee_cents,
        ${sumPostings(payable, '-')} as owed_to_you_cents
    `)
    const [row] = result.rows
    if (!row) throw new Error('Dashboard query returned no row')

    const body: DashboardDto = {
      gmvCents: exactCents(row.gmv_cents, 'GMV'),
      providerMarginCents: exactCents(row.provider_margin_cents, 'margin'),
      platformFeeCents: exactCents(row.platform_fee_cents, 'processing fees'),
      owedToYouCents: exactCents(row.owed_to_you_cents, 'owed to you'),
      range,
    }
    res.json(body)
  })

  return router
}
