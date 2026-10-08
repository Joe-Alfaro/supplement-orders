import {
  listPatientsQuerySchema,
  parseDateOfBirthQuery,
  type LatestOrderStatusFilter,
  type OrderStatus,
  type PatientDto,
  type PatientPageDto,
} from '@supplement-orders/domain'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { Router } from 'express'
import type { Db } from '../db/client'
import { ordersWithStatus, patients, users } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { notFound } from './errors'
import { matchesSearch } from './search'
import { parseId, parseOrThrow } from './validate'

interface PageWindow {
  offset: number
  limit: number
}

/**
 * The Patients table order (name, then id). The login list reuses it so its
 * "first two patients" can't drift from the table.
 */
export const patientListOrder = [asc(users.name), asc(patients.id)]

/** Patients matching `where`, with order counts for just the returned rows. */
async function selectPatients(
  db: Db,
  providerId: number,
  where: SQL | undefined,
  window?: PageWindow,
): Promise<PatientDto[]> {
  const query = db
    .select({
      id: patients.id,
      userId: patients.userId,
      providerId: patients.providerId,
      name: users.name,
      dateOfBirth: patients.dateOfBirth,
      address: patients.address,
    })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(where)
    .orderBy(...patientListOrder)
  const rows = window
    ? await query.limit(window.limit).offset(window.offset)
    : await query
  if (rows.length === 0) return []

  // Read through the view, so the latest status is the derived one (revision 14.3b).
  const orderRows = await db
    .select({
      patientId: ordersWithStatus.patientId,
      status: ordersWithStatus.effectiveStatus,
    })
    .from(ordersWithStatus)
    .where(
      and(
        eq(ordersWithStatus.providerId, providerId),
        inArray(
          ordersWithStatus.patientId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(desc(ordersWithStatus.createdAt), desc(ordersWithStatus.id))

  return rows.map((row): PatientDto => {
    const own = orderRows.filter((o) => o.patientId === row.id)
    const latest: OrderStatus | null = own[0]?.status ?? null
    return { ...row, orderCount: own.length, latestOrderStatus: latest }
  })
}

/**
 * Name substring, plus an exact date-of-birth match when the whole query is a
 * valid date. Address is deliberately not searched (revision 3b).
 */
function patientSearch(q: string | null): SQL | undefined {
  if (q === null) return undefined
  const dateOfBirth = parseDateOfBirthQuery(q)
  return or(
    matchesSearch(q, [users.name]),
    dateOfBirth === null ? undefined : eq(patients.dateOfBirth, dateOfBirth),
  )
}

/**
 * Effective status (revision 14.3b, from the orders_with_status view) of the
 * patient's most recent order (created_at desc, id desc, the same order the
 * PatientDto's latestOrderStatus uses), as a correlated subquery served by
 * orders_patient_created_idx (migration 0006). Null with no orders.
 */
const latestOrderStatus = sql`(select ${ordersWithStatus.effectiveStatus} from ${ordersWithStatus} where ${ordersWithStatus.patientId} = ${patients.id} order by ${ordersWithStatus.createdAt} desc, ${ordersWithStatus.id} desc limit 1)`

function latestStatusFilter(
  latestStatus: LatestOrderStatusFilter | undefined,
): SQL | undefined {
  if (latestStatus === undefined) return undefined
  if (latestStatus === 'none') return sql`${latestOrderStatus} is null`
  return sql`${latestOrderStatus} = ${latestStatus}`
}

/** Provider only, scoped to the provider's own patients. */
export function patientsRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const { q, offset, limit, latestStatus } = parseOrThrow(
      listPatientsQuerySchema,
      req.query,
    )
    const where = and(
      eq(patients.providerId, user.providerId),
      patientSearch(q),
      latestStatusFilter(latestStatus),
    )

    const [items, [counted]] = await Promise.all([
      selectPatients(db, user.providerId, where, { offset, limit }),
      db
        .select({ total: count() })
        .from(patients)
        .innerJoin(users, eq(users.id, patients.userId))
        .where(where),
    ])
    const body: PatientPageDto = {
      items,
      total: counted?.total ?? 0,
      offset,
      limit,
    }
    res.json(body)
  })

  router.get('/:id', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const id = parseId(req.params.id)
    const [patient] = await selectPatients(
      db,
      user.providerId,
      eq(patients.id, id),
    )
    // Revision 18.4 (L6): another practice's patient is 404, not 403.
    if (!patient || patient.providerId !== user.providerId) {
      throw notFound('Patient')
    }
    res.json(patient)
  })

  return router
}
