import {
  listPatientsQuerySchema,
  type OrderStatus,
  type PatientDto,
  type PatientPageDto,
} from '@supplement-orders/domain'
import { and, asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { Router } from 'express'
import type { Db } from '../db/client'
import { orders, patients, users } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { forbidden, notFound } from './errors'
import { matchesSearch } from './search'
import { parseId, parseOrThrow } from './validate'

interface PageWindow {
  offset: number
  limit: number
}

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
      address: patients.address,
    })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(where)
    .orderBy(asc(users.name), asc(patients.id))
  const rows = window
    ? await query.limit(window.limit).offset(window.offset)
    : await query
  if (rows.length === 0) return []

  const orderRows = await db
    .select({ patientId: orders.patientId, status: orders.status })
    .from(orders)
    .where(
      and(
        eq(orders.providerId, providerId),
        inArray(
          orders.patientId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))

  return rows.map((row): PatientDto => {
    const own = orderRows.filter((o) => o.patientId === row.id)
    const latest: OrderStatus | null = own[0]?.status ?? null
    return { ...row, orderCount: own.length, latestOrderStatus: latest }
  })
}

/** Provider only, scoped to the provider's own patients. */
export function patientsRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const { q, offset, limit } = parseOrThrow(
      listPatientsQuerySchema,
      req.query,
    )
    const where = and(
      eq(patients.providerId, user.providerId),
      matchesSearch(q, [users.name, patients.address]),
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
    if (!patient) throw notFound('Patient')
    if (patient.providerId !== user.providerId) {
      throw forbidden('This patient belongs to another provider')
    }
    res.json(patient)
  })

  return router
}
