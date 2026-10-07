import { useToast } from 'primevue/usetoast'

const SUCCESS_LIFE_MS = 3000

/** Transient success confirmations: one shared look for every view. */
export function useSuccessToast() {
  const toast = useToast()
  return function showSuccess(message: string) {
    toast.add({ severity: 'success', summary: message, life: SUCCESS_LIFE_MS })
  }
}
