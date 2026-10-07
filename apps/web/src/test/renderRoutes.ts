import { render } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Toast from 'primevue/toast'
import ToastService from 'primevue/toastservice'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { primeVueOptions } from '../primevue'
import { routes } from '../router'

/** Renders the app's real routes (without the auth guards) at a path. */
export async function renderRoutes(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  // App.vue mounts the one Toast; the routes rendered alone need it beside them.
  const Host = defineComponent({
    render: () => [h(RouterView), h(Toast)],
  })
  const result = render(Host, {
    global: {
      plugins: [
        router,
        [PrimeVue, primeVueOptions],
        ConfirmationService,
        ToastService,
      ],
    },
  })
  return { ...result, router }
}
