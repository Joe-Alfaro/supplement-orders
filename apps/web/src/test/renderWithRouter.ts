import { render } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import type { Component } from 'vue'
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
  const result = render(component, {
    props: options.props,
    global: {
      plugins: [router, [PrimeVue, primeVueOptions], ConfirmationService],
    },
  })
  return { ...result, router }
}
