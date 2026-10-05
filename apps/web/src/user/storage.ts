const USER_ID_STORAGE_KEY = 'supplementOrders.userId'

export function readStoredUserId(): number | null {
  const raw = localStorage.getItem(USER_ID_STORAGE_KEY)
  if (raw === null) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function writeStoredUserId(id: number | null) {
  if (id === null) {
    localStorage.removeItem(USER_ID_STORAGE_KEY)
    return
  }
  localStorage.setItem(USER_ID_STORAGE_KEY, String(id))
}
