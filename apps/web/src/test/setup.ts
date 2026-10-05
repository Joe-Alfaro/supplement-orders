import { cleanup } from '@testing-library/vue'
import { afterEach } from 'vitest'

// Testing Library only auto-cleans when Vitest globals are on; they are not here.
afterEach(cleanup)
