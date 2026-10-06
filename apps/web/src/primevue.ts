import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'
import type { PrimeVueConfiguration } from 'primevue/config'

/**
 * Aura with accessibility fixes: its default primary (emerald-500) is 2.5:1
 * against white, below WCAG AA for link text and white button labels. Using the
 * 700 shade as the primary color gives about 5.5:1 in both directions.
 * The danger button (red-500, 3.8:1) and the error and warn Message text
 * (red-600 and yellow-600 on their tinted backgrounds) fail AA in a real
 * browser too, so they move to the 700 and 800 shades.
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
  components: {
    button: {
      colorScheme: {
        light: {
          root: {
            danger: {
              background: '{red.700}',
              hoverBackground: '{red.800}',
              activeBackground: '{red.900}',
              borderColor: '{red.700}',
              hoverBorderColor: '{red.800}',
              activeBorderColor: '{red.900}',
            },
          },
          outlined: {
            danger: { color: '{red.700}' },
          },
        },
      },
    },
    message: {
      colorScheme: {
        light: {
          error: { color: '{red.700}' },
          warn: { color: '{yellow.800}' },
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
