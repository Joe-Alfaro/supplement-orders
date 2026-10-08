import type { Role } from '@supplement-orders/domain'
import { ref } from 'vue'
import {
  ApiRequestError,
  getCurrentUser,
  handleApiError,
  listSignInOptions,
  onUnauthenticated,
  type SignInOptionDto,
} from '../api'
import { showNotice } from './notice'
import { readStoredUserId, writeStoredUserId } from './storage'

// Module-level state: the current user is the app's only cross-screen client state.
// The app never loads a user directory: the session is restored from /users/me
// and the login screen lists only the curated demo personas.
const signInOptions = ref<SignInOptionDto[]>([])
const selectedUserId = ref<number | null>(readStoredUserId())
const currentUser = ref<SignInOptionDto | null>(null)
const loadError = ref<string | null>(null)
let pendingRestore: Promise<void> | null = null
let pendingSignInOptions: Promise<void> | null = null

function isUnauthenticated(err: unknown) {
  return err instanceof ApiRequestError && err.status === 401
}

async function restoreSession() {
  if (selectedUserId.value === null) {
    currentUser.value = null
    return
  }
  try {
    currentUser.value = await getCurrentUser()
    loadError.value = null
  } catch (err) {
    currentUser.value = null
    // The server no longer knows the stored id: forget it quietly.
    if (isUnauthenticated(err)) {
      signOut()
      return
    }
    loadError.value = handleApiError(err)
    pendingRestore = null
  }
}

/** Restores the stored session once; later calls reuse the same request. */
function ensureSessionRestored() {
  if (!pendingRestore) pendingRestore = restoreSession()
  return pendingRestore
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

/** Stores the id; the next route guard confirms it through /users/me. */
function signIn(id: number) {
  selectedUserId.value = id
  writeStoredUserId(id)
  currentUser.value = null
  pendingRestore = null
}

function signOut() {
  selectedUserId.value = null
  currentUser.value = null
  pendingRestore = Promise.resolve()
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
    signInOptions,
    currentUser,
    loadError,
    ensureSessionRestored,
    ensureSignInOptionsLoaded,
    signIn,
    signOut,
  }
}
