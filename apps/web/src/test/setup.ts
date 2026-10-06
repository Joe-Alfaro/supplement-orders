import { cleanup } from '@testing-library/vue'
import { afterEach } from 'vitest'

// Testing Library only auto-cleans when Vitest globals are on; they are not here.
afterEach(cleanup)

// jsdom has no matchMedia; PrimeVue's DataTable and overlays query it.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}
