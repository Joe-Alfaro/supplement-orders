import { ref, shallowRef } from 'vue'
import { handleApiError } from './api'

/** loading / error / data refs for a view that fetches on mount. */
export function useResource<T>(loader: () => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Only the latest load may write, so a slow earlier request can't overwrite
  // the result of a newer one (for example after the filter changed).
  let latest = 0

  async function load() {
    const mine = ++latest
    loading.value = true
    error.value = null
    try {
      const result = await loader()
      if (mine === latest) data.value = result
    } catch (err) {
      if (mine === latest) error.value = handleApiError(err)
    } finally {
      if (mine === latest) loading.value = false
    }
  }

  return { data, loading, error, load }
}
