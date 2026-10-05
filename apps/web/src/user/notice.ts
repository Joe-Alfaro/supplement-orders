import { ref } from 'vue'

interface Notice {
  message: string
  /** The notice stays visible only while the user is on this path. */
  path: string
}

export const notice = ref<Notice | null>(null)

export function showNotice(message: string, path: string) {
  notice.value = { message, path }
}

export function clearNoticeUnlessOn(path: string) {
  if (notice.value && notice.value.path !== path) notice.value = null
}
