import type { SignInOptionDto, UserDto } from '@supplement-orders/domain'
import { asc, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { patients, providers, users } from '../db/schema'
import type { AppContext } from '../server'
import { ApiError } from './errors'
import { patientListOrder } from './patients'

/** Patients shown under each provider on the login screen. */
const SIGN_IN_PATIENTS_PER_PROVIDER = 2

/**
 * GET /api/users/sign-in-options is public: the login screen needs it before
 * anyone is selected. There is no public user directory; GET /api/users/me
 * returns only the caller.
 */
export function usersRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/me', async (req, res) => {
    const { userId } = await auth.getCurrentUser(req)
    const [row] = await db
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
      .where(eq(users.id, userId))
    if (!row) throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown user')
    const body: UserDto = row
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
        })
        .from(providers)
        .innerJoin(users, eq(users.id, providers.userId))
        .orderBy(asc(providers.id)),
      db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          ownerProviderId: rankedPatients.providerId,
        })
        .from(rankedPatients)
        .innerJoin(users, eq(users.id, rankedPatients.userId))
        .where(sql`${rankedPatients.rank} <= ${SIGN_IN_PATIENTS_PER_PROVIDER}`)
        .orderBy(asc(rankedPatients.providerId), asc(rankedPatients.rank)),
      db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(eq(users.role, 'admin'))
        .orderBy(asc(users.id)),
    ])

    // Only id, name and role: profile ids stay with GET /api/users/me.
    function option(row: SignInOptionDto): SignInOptionDto {
      return { id: row.id, name: row.name, role: row.role }
    }
    const body: SignInOptionDto[] = [
      ...providerRows.flatMap((provider) => [
        option(provider),
        ...patientRows
          .filter((row) => row.ownerProviderId === provider.providerId)
          .map(option),
      ]),
      ...adminRows,
    ]
    res.json(body)
  })

  return router
}
