import { onScopeDispose } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'

/**
 * URL writes for a list view whose state lives in the query (§4.6b), made safe
 * against navigation. A debounced search used to call router.replace after the
 * user had clicked a link away; the replace superseded that pending push (for
 * example while a lazy route chunk loaded) and stranded the user on the list.
 *
 * - Leaving the view (any navigation to another path) runs the registered
 *   cancel callbacks, so pending debounces never fire afterwards; so does
 *   unmounting.
 * - replaceQuery/pushQuery do nothing unless the router is still on this view
 *   and no navigation is in flight.
 */
export function useListUrl() {
  const router = useRouter()
  const route = useRoute()
  const listPath = route.path

  let navigating = false
  const onLeaveCallbacks: (() => void)[] = []

  function runLeaveCallbacks() {
    onLeaveCallbacks.forEach((callback) => callback())
  }

  const removeBeforeEach = router.beforeEach((to) => {
    navigating = true
    if (to.path !== listPath) runLeaveCallbacks()
  })
  const removeAfterEach = router.afterEach(() => {
    navigating = false
  })
  const removeOnError = router.onError(() => {
    navigating = false
  })

  onScopeDispose(() => {
    removeBeforeEach()
    removeAfterEach()
    removeOnError()
    runLeaveCallbacks()
  })

  /** Still showing this view, with no navigation in flight. */
  function isCurrent() {
    return !navigating && router.currentRoute.value.path === listPath
  }

  function replaceQuery(query: LocationQueryRaw) {
    if (!isCurrent()) return undefined
    return router.replace({ query })
  }

  function pushQuery(query: LocationQueryRaw) {
    if (router.currentRoute.value.path !== listPath) return undefined
    return router.push({ query })
  }

  /** Register cleanup (e.g. a debounce cancel) to run when the view is left. */
  function onLeave(callback: () => void) {
    onLeaveCallbacks.push(callback)
  }

  return { listPath, isCurrent, replaceQuery, pushQuery, onLeave }
}
