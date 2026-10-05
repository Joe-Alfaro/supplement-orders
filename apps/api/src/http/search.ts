import { ilike, or, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

/** Escapes LIKE metacharacters so `%`, `_` and `\` in a search match literally. */
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Case-insensitive substring match of `q` against any of `columns`, or no
 * filter when `q` is null. Postgres's default LIKE escape character is `\`.
 */
export function matchesSearch(
  q: string | null,
  columns: PgColumn[],
): SQL | undefined {
  if (q === null) return undefined
  const pattern = `%${escapeLike(q)}%`
  return or(...columns.map((column) => ilike(column, pattern)))
}
