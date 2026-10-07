import { render } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { primeVueOptions } from '../primevue'
import { routes } from '../router'

/** Renders the app's real routes (without the auth guards) at a path. */
export async function renderRoutes(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const result = render(RouterView, {
    global: {
      plugins: [router, [PrimeVue, primeVueOptions], ConfirmationService],
    },
  })
  return { ...result, router }
}
