import type { Role, UserDto } from '@supplement-orders/domain'
import { computed, ref } from 'vue'
import { errorMessage, listUsers } from '../api'
import { readStoredUserId, writeStoredUserId } from './storage'

// Module-level state: the current user is the app's only cross-screen client state.
const users = ref<UserDto[]>([])
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
    loadError.value = errorMessage(err)
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

export function homePathFor(role: Role) {
  return role === 'provider' ? '/patients' : '/my-orders'
}

export function roleLabel(role: Role) {
  return role === 'provider' ? 'Provider' : 'Patient'
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
