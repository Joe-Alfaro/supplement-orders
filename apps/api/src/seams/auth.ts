import { USER_ID_HEADER, idParamSchema, type Role } from '@supplement-orders/domain'
import { eq } from 'drizzle-orm'
import type { Request } from 'express'
import type { Db } from '../db/client'
import { patients, providers, users } from '../db/schema'
import { ApiError } from '../http/errors'

export type CurrentUser =
  | { userId: number; role: 'provider'; providerId: number }
  | { userId: number; role: 'patient'; patientId: number; providerId: number }

export interface Auth {
  /** Resolves the acting user or throws ApiError UNAUTHENTICATED. */
  getCurrentUser(req: Request): Promise<CurrentUser>
}

/**
 * Fake auth: trusts the X-User-Id header to name a seeded user, then reads the role
 * from the users table. The client never asserts a role.
 */
export class HeaderAuth implements Auth {
  constructor(private readonly db: Db) {}

  async getCurrentUser(req: Request): Promise<CurrentUser> {
    const parsed = idParamSchema.safeParse(req.get(USER_ID_HEADER))
    if (!parsed.success) {
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        `Missing or invalid ${USER_ID_HEADER} header`,
      )
    }
    const [user] = await this.db
      .select({
        id: users.id,
        role: users.role,
        providerId: providers.id,
        patientId: patients.id,
        patientProviderId: patients.providerId,
      })
      .from(users)
      .leftJoin(providers, eq(providers.userId, users.id))
      .leftJoin(patients, eq(patients.userId, users.id))
      .where(eq(users.id, parsed.data))
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown user')
    if (user.role === 'provider' && user.providerId !== null) {
      return { userId: user.id, role: 'provider', providerId: user.providerId }
    }
    if (
      user.role === 'patient' &&
      user.patientId !== null &&
      user.patientProviderId !== null
    ) {
      return {
        userId: user.id,
        role: 'patient',
        patientId: user.patientId,
        providerId: user.patientProviderId,
      }
    }
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      'User has no profile for its role',
    )
  }
}

/** Throws FORBIDDEN unless the user has the given role; narrows the type. */
export function requireRole<R extends Role>(
  user: CurrentUser,
  role: R,
): Extract<CurrentUser, { role: R }> {
  if (user.role !== role) {
    throw new ApiError(403, 'FORBIDDEN', `Only a ${role} can do this`)
  }
  return user as Extract<CurrentUser, { role: R }>
}
