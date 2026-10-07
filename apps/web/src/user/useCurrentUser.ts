import type { Role, UserDto } from '@supplement-orders/domain'
import { computed, ref } from 'vue'
import {
  handleApiError,
  listSignInOptions,
  listUsers,
  onUnauthenticated,
} from '../api'
import { showNotice } from './notice'
import { readStoredUserId, writeStoredUserId } from './storage'

// Module-level state: the current user is the app's only cross-screen client state.
const users = ref<UserDto[]>([])
// The curated login list. `users` stays the full list so a restored session
// works for any user, listed here or not.
const signInOptions = ref<UserDto[]>([])
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
export function userOptions(users: readonly UserDto[]) {
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
