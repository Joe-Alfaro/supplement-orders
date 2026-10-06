import Aura from '@primeuix/themes/aura'
import type { PrimeVueConfiguration } from 'primevue/config'

/** Shared by main.ts and the test render helpers: Aura preset, light only. */
export const primeVueOptions: PrimeVueConfiguration = {
  theme: {
    preset: Aura,
    options: { darkModeSelector: false },
  },
}
