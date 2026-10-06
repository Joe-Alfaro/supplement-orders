import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'
import type { PrimeVueConfiguration } from 'primevue/config'

/**
 * Aura with one accessibility fix: its default primary (emerald-500) is 2.5:1
 * against white, below WCAG AA for link text and white button labels. Using the
 * 700 shade as the primary color gives about 5.5:1 in both directions.
 */
const AccessibleAura = definePreset(Aura, {
  semantic: {
    colorScheme: {
      light: {
        primary: {
          color: '{primary.700}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.800}',
          activeColor: '{primary.900}',
        },
        highlight: {
          background: '{primary.50}',
          focusBackground: '{primary.100}',
          color: '{primary.800}',
          focusColor: '{primary.900}',
        },
      },
    },
  },
})

/** Shared by main.ts and the test render helpers: light only. */
export const primeVueOptions: PrimeVueConfiguration = {
  theme: {
    preset: AccessibleAura,
    options: { darkModeSelector: false },
  },
}
