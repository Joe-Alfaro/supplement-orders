import type { OrderStatus, PatientDto } from '@supplement-orders/domain'
import { asc, desc, eq } from 'drizzle-orm'
import { Router } from 'express'
import type { Db } from '../db/client'
import { orders, patients, users } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { forbidden, notFound } from './errors'
import { parseId } from './validate'

async function loadPatients(db: Db, providerId: number, patientId?: number) {
  const rows = await db
    .select({
      id: patients.id,
      userId: patients.userId,
      providerId: patients.providerId,
      name: users.name,
      address: patients.address,
    })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(
      patientId === undefined
        ? eq(patients.providerId, providerId)
        : eq(patients.id, patientId),
    )
    .orderBy(asc(users.name))
  const orderRows = await db
    .select({ patientId: orders.patientId, status: orders.status })
    .from(orders)
    .where(eq(orders.providerId, providerId))
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
    res.json(await loadPatients(db, user.providerId))
  })

  router.get('/:id', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const id = parseId(req.params.id)
    const [patient] = await loadPatients(db, user.providerId, id)
    if (!patient) throw notFound('Patient')
    if (patient.providerId !== user.providerId) {
      throw forbidden('This patient belongs to another provider')
    }
    res.json(patient)
  })

  return router
}
