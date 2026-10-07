import { render } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Toast from 'primevue/toast'
import ToastService from 'primevue/toastservice'
import { defineComponent, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { primeVueOptions } from '../primevue'

const Stub = { template: '<div />' }

/** Renders a view with a throwaway router so RouterLink and useRouter work. */
export async function renderWithRouter(
  component: Component,
  options: { path?: string; props?: Record<string, unknown> } = {},
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: Stub }],
  })
  await router.push(options.path ?? '/')
  await router.isReady()
  // App.vue mounts the one Toast; views rendered alone need it beside them.
  const Host = defineComponent({
    render: () => [h(component, options.props), h(Toast)],
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
