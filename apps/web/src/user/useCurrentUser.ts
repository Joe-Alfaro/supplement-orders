import type { Role, SignInOptionDto, UserDto } from '@supplement-orders/domain'
import { computed, ref } from 'vue'
import {
  ApiRequestError,
  handleApiError,
  listSignInOptions,
  listUsers,
  onUnauthenticated,
} from '../api'
import { showNotice } from './notice'
import { readStoredUserId, writeStoredUserId } from './storage'

// Module-level state: the current user is the app's only cross-screen client state.
// Revision 17.1: `users` holds only the signed-in user, from GET /api/users/me,
// so a restored session works for any user, listed at sign-in or not.
const users = ref<UserDto[]>([])
// The curated login list.
const signInOptions = ref<SignInOptionDto[]>([])
const selectedUserId = ref<number | null>(readStoredUserId())
const loadError = ref<string | null>(null)
let pendingLoad: Promise<void> | null = null
let pendingSignInOptions: Promise<void> | null = null

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
    // A stored id the server no longer knows: forget it quietly.
    if (err instanceof ApiRequestError && err.status === 401) {
      users.value = []
      signOut()
      return
    }
    loadError.value = handleApiError(err)
    pendingLoad = null
  }
}

/** Loads the user list once; later calls reuse the same request. */
function ensureUsersLoaded() {
  if (!pendingLoad) pendingLoad = loadUsers()
  return pendingLoad
}

async function loadSignInOptions() {
  try {
    signInOptions.value = await listSignInOptions()
    loadError.value = null
  } catch (err) {
    loadError.value = handleApiError(err)
    pendingSignInOptions = null
  }
}

/** Loads the login list once; later calls reuse the same request. */
function ensureSignInOptionsLoaded() {
  if (!pendingSignInOptions) pendingSignInOptions = loadSignInOptions()
  return pendingSignInOptions
}

function signIn(id: number) {
  selectedUserId.value = id
  writeStoredUserId(id)
  // The next navigation loads the new user from GET /api/users/me.
  pendingLoad = null
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

const HOME_PATHS: Record<Role, string> = {
  provider: '/patients',
  patient: '/my-orders',
  admin: '/admin/inventory',
}

const ROLE_LABELS: Record<Role, string> = {
  provider: 'Provider',
  patient: 'Patient',
  admin: 'Admin',
}

export function homePathFor(role: Role) {
  return HOME_PATHS[role]
}

export function roleLabel(role: Role) {
  return ROLE_LABELS[role]
}

/**
 * Login picker options. Seeded users can share a name, so the user id is added
 * to tell them apart.
 */
export function userOptions(users: readonly SignInOptionDto[]) {
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
    signInOptions,
    currentUser,
    loadError,
    ensureUsersLoaded,
    ensureSignInOptionsLoaded,
    signIn,
    signOut,
  }
}
