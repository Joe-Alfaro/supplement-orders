import type { ListQuery, Page } from '@supplement-orders/domain'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { handleApiError } from '../api'

export interface PagedSearchOptions {
  initialQuery?: string
  /** First row to load, e.g. restored from `?page=` in the URL. */
  initialOffset?: number
  limit?: number
  debounceMs?: number
  /**
   * When set, a settled (debounced) search box value is handed here instead of
   * searching directly, e.g. to write it to the URL; the caller then applies
   * it with `apply`. Lets the URL be the single source of truth.
   */
  onCommit?: (q: string) => void
}

export const PAGE_SIZE = 25
export const SEARCH_DEBOUNCE_MS = 250

/**
 * Server-side search plus offset pagination over a `Page<T>` endpoint.
 * Typing is debounced and resets to the first page; responses that arrive
 * after a newer request are ignored so results never go stale.
 */
export function usePagedSearch<T>(
  fetchPage: (query: ListQuery) => Promise<Page<T>>,
  options: PagedSearchOptions = {},
) {
  const limit = options.limit ?? PAGE_SIZE
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS

  /** What is in the search box. */
  const query = ref(options.initialQuery ?? '')
  /** The query behind the current results. */
  const activeQuery = ref(query.value.trim())
  const offset = ref(Math.max(0, options.initialOffset ?? 0))
  const page = shallowRef<Page<T> | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let timer: ReturnType<typeof setTimeout> | undefined
  let latestRequest = 0

  async function load() {
    const requestId = ++latestRequest
    loading.value = true
    error.value = null
    try {
      const result = await fetchPage({
        q: activeQuery.value,
        offset: offset.value,
        limit,
      })
      if (requestId === latestRequest) page.value = result
    } catch (err) {
      if (requestId === latestRequest) error.value = handleApiError(err)
    } finally {
      if (requestId === latestRequest) loading.value = false
    }
  }

  function cancelPending() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function search(value: string) {
    cancelPending()
    activeQuery.value = value.trim()
    offset.value = 0
    return load()
  }

  /** Call on every keystroke; the request goes out after the debounce. */
  function setQuery(value: string) {
    query.value = value
    cancelPending()
    timer = setTimeout(() => {
      timer = undefined
      if (options.onCommit) {
        options.onCommit(value.trim())
        return
      }
      search(value)
    }, debounceMs)
  }

  function clear() {
    query.value = ''
    return search('')
  }

  const items = computed(() => page.value?.items ?? [])
  const total = computed(() => page.value?.total ?? 0)
  const canPrevious = computed(() => offset.value > 0)
  const canNext = computed(() => offset.value + limit < total.value)

  function next() {
    if (!canNext.value) return
    offset.value += limit
    return load()
  }

  function previous() {
    if (!canPrevious.value) return
    offset.value = Math.max(0, offset.value - limit)
    return load()
  }

  /**
   * Back to the first page and fetch again, keeping the current query. Use
   * when a filter outside the search box changes (fetchPage reads it).
   */
  function restart() {
    cancelPending()
    offset.value = 0
    return load()
  }

  /**
   * Load exactly this query and offset, e.g. from the URL. The search box text
   * follows the query unless the user is mid-typing. (Orders, Patients.)
   */
  function apply(state: { q?: string; offset: number }) {
    if (state.q !== undefined) {
      activeQuery.value = state.q.trim()
      if (timer === undefined) query.value = state.q
    }
    offset.value = Math.max(0, state.offset)
    return load()
  }

  /**
   * Show exactly this search and page, e.g. when Back/Forward changes the URL.
   * Cancels pending typing so the box and the results agree. (Dashboard.)
   */
  function show(value: string, first: number) {
    cancelPending()
    query.value = value
    activeQuery.value = value.trim()
    offset.value = Math.max(0, first)
    return load()
  }

  /** Jump to a page by its first row, e.g. from DataTable's `@page`. */
  function goTo(first: number) {
    const target = Math.max(0, first)
    if (target === offset.value) return
    offset.value = target
    return load()
  }

  onScopeDispose(cancelPending)

  return {
    query,
    activeQuery,
    offset,
    limit,
    page,
    items,
    total,
    loading,
    error,
    canPrevious,
    canNext,
    load,
    setQuery,
    /** Drop a pending debounced search, e.g. when leaving the view. */
    cancel: cancelPending,
    clear,
    next,
    previous,
    goTo,
    restart,
    apply,
    show,
  }
}
