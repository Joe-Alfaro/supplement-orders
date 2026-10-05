export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString()
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString()
}
