import type { LocationQuery } from 'vue-router'

// Helpers for list views whose state lives in the URL query (FRONTEND_DESIGN
// §4.6b): links, reloads and Back/Forward restore the exact view.

/** A single string query value, or undefined (arrays and nulls are ignored). */
export function queryString(query: LocationQuery, key: string) {
  const value = query[key]
  return typeof value === 'string' ? value : undefined
}

/** `?page=` as a 1-based page number; anything invalid is page 1. */
export function pageFromQuery(query: LocationQuery) {
  const raw = queryString(query, 'page')
  if (!raw || !/^\d+$/.test(raw)) return 1
  return Math.max(1, Number(raw))
}

export function offsetForPage(page: number, limit: number) {
  return (page - 1) * limit
}

export function pageForOffset(offset: number, limit: number) {
  return Math.floor(offset / limit) + 1
}

/**
 * A URL query with defaults left out: empty or undefined values are dropped,
 * and page 1 is never written.
 */
export function listQuery(params: Record<string, string | number | undefined>) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([key, value]) => {
        if (value === undefined || value === '') return false
        return !(key === 'page' && Number(value) <= 1)
      })
      .map(([key, value]) => [key, String(value)]),
  )
}
