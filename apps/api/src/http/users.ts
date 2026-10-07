import type { UserDto } from '@supplement-orders/domain'
import { asc, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { patients, providers, users } from '../db/schema'
import type { AppContext } from '../server'
import { patientListOrder } from './patients'

/** Patients shown under each provider on the login screen. */
const SIGN_IN_PATIENTS_PER_PROVIDER = 2

/** GET /api/users and /api/users/sign-in-options are public: the login screen needs them before anyone is selected. */
export function usersRouter({ db }: AppContext) {
  const router = Router()

  router.get('/', async (_req, res) => {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        providerId: providers.id,
        patientId: patients.id,
      })
      .from(users)
      .leftJoin(providers, eq(providers.userId, users.id))
      .leftJoin(patients, eq(patients.userId, users.id))
      .orderBy(asc(users.id))
    const body: UserDto[] = rows
    res.json(body)
  })

  /** Curated login list: each provider, their first patients, then the admins. */
  router.get('/sign-in-options', async (_req, res) => {
    const rankedPatients = db
      .select({
        userId: patients.userId,
        providerId: patients.providerId,
        rank: sql<number>`row_number() over (partition by ${patients.providerId} order by ${sql.join(patientListOrder, sql`, `)})`.as(
          'rank',
        ),
      })
      .from(patients)
      .innerJoin(users, eq(users.id, patients.userId))
      .as('ranked_patients')

    const [providerRows, patientRows, adminRows] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          providerId: providers.id,
          patientId: sql<null>`null`,
        })
        .from(providers)
        .innerJoin(users, eq(users.id, providers.userId))
        .orderBy(asc(providers.id)),
      db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          providerId: sql<null>`null`,
          patientId: patients.id,
          ownerProviderId: rankedPatients.providerId,
        })
        .from(rankedPatients)
        .innerJoin(users, eq(users.id, rankedPatients.userId))
        .innerJoin(patients, eq(patients.userId, users.id))
        .where(sql`${rankedPatients.rank} <= ${SIGN_IN_PATIENTS_PER_PROVIDER}`)
        .orderBy(asc(rankedPatients.providerId), asc(rankedPatients.rank)),
      db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          providerId: sql<null>`null`,
          patientId: sql<null>`null`,
        })
        .from(users)
        .where(eq(users.role, 'admin'))
        .orderBy(asc(users.id)),
    ])

    const body: UserDto[] = [
      ...providerRows.flatMap((provider) => [
        provider,
        ...patientRows
          .filter((row) => row.ownerProviderId === provider.providerId)
          .map((row): UserDto => ({
            id: row.id,
            name: row.name,
            role: row.role,
            providerId: row.providerId,
            patientId: row.patientId,
          })),
      ]),
      ...adminRows,
    ]
    res.json(body)
  })

  return router
}
