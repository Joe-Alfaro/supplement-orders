import { execFileSync } from 'node:child_process'

/** Resets supplement_orders_e2e to the small deterministic seed before the servers start. */
export default function globalSetup(): void {
  execFileSync('npm', ['run', 'e2e:db'], { stdio: 'inherit' })
}
