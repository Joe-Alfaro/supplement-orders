import { e2eDatabaseUrl } from './db/databases'

// `npm run e2e:api`: the normal server, pinned to the e2e database and port 3100
// so it can run beside the dev servers. Env is set before the app loads its config.
process.env.DATABASE_URL = e2eDatabaseUrl()
process.env.PORT = process.env.E2E_API_PORT ?? '3100'

await import('./index')
