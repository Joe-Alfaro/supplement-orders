import { ref, shallowRef } from 'vue'
import { handleApiError } from './api'

/** loading / error / data refs for a view that fetches on mount. */
export function useResource<T>(loader: () => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load() {
    loading.value = true
    error.value = null
    try {
      data.value = await loader()
    } catch (err) {
      error.value = handleApiError(err)
    } finally {
      loading.value = false
    }
  }

  return { data, loading, error, load }
}
