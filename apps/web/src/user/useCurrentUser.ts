import type { UserDto } from '@supplement-orders/domain'
import { computed, ref } from 'vue'
import type { AppRole } from '../admin/types'
import { handleApiError, listUsers, onUnauthenticated } from '../api'
import { showNotice } from './notice'
import { readStoredUserId, writeStoredUserId } from './storage'

/** UserDto with the admin role (the shared Role lacks it until the API merges). */
export type AppUser = Omit<UserDto, 'role'> & { role: AppRole }

// Module-level state: the current user is the app's only cross-screen client state.
const users = ref<AppUser[]>([])
const selectedUserId = ref<number | null>(readStoredUserId())
const loadError = ref<string | null>(null)
let pendingLoad: Promise<void> | null = null

const currentUser = computed(
  () => users.value.find((user) => user.id === selectedUserId.value) ?? null,
)

async function loadUsers() {
  try {
    users.value = await listUsers()
    loadError.value = null
    // Forget a stored id that no longer matches a seeded user.
    if (selectedUserId.value !== null && !currentUser.value) signOut()
  } catch (err) {
    loadError.value = handleApiError(err)
    pendingLoad = null
  }
}

/** Loads the user list once; later calls reuse the same request. */
function ensureUsersLoaded() {
  if (!pendingLoad) pendingLoad = loadUsers()
  return pendingLoad
}

function signIn(id: number) {
  selectedUserId.value = id
  writeStoredUserId(id)
}

function signOut() {
  selectedUserId.value = null
  writeStoredUserId(null)
}

// Any 401 means the stored user is no longer valid: sign out with a notice.
// App.vue sends a signed-out user to /login.
onUnauthenticated(() => {
  if (selectedUserId.value === null) return
  signOut()
  showNotice('Your session has ended. Please sign in again.', '/login')
})

const HOME_PATHS: Record<AppRole, string> = {
  provider: '/patients',
  patient: '/my-orders',
  admin: '/admin/inventory',
}

const ROLE_LABELS: Record<AppRole, string> = {
  provider: 'Provider',
  patient: 'Patient',
  admin: 'Admin',
}

export function homePathFor(role: AppRole) {
  return HOME_PATHS[role]
}

export function roleLabel(role: AppRole) {
  return ROLE_LABELS[role]
}

/**
 * Login picker options. Seeded users can share a name, so the user id is added
 * to tell them apart.
 */
export function userOptions(users: readonly AppUser[]) {
  return users.map((user) => {
    const label = `${user.name} (${roleLabel(user.role)})`
    const shared = users.some(
      (other) => other.id !== user.id && other.name === user.name,
    )
    return {
      id: user.id,
      label: shared ? `${label} · user #${user.id}` : label,
    }
  })
}

export function useCurrentUser() {
  return {
    users,
    currentUser,
    loadError,
    ensureUsersLoaded,
    signIn,
    signOut,
  }
}
