import type { UserDto } from '@supplement-orders/domain'
import { asc, eq } from 'drizzle-orm'
import { Router } from 'express'
import { patients, providers, users } from '../db/schema'
import type { AppContext } from '../server'

/** GET /api/users is public: the user switcher needs it before anyone is selected. */
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

  return router
}
