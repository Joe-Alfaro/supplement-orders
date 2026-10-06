import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, webDistDir } from './config'
import { createDb } from './db/client'
import { ConsoleNotifier, FakePaymentGateway } from './seams'
import { createApp } from './server'

const config = loadConfig()
const webDist = webDistDir()
// Fail at boot, not on the first page view, if the web build is missing.
if (webDist && !existsSync(join(webDist, 'index.html'))) {
  throw new Error(`No web build at ${webDist}; run npm run build first`)
}

const { db, ping } = createDb(config.DATABASE_URL)
const app = createApp({
  db,
  pingDb: ping,
  gateway: new FakePaymentGateway(),
  notifier: new ConsoleNotifier(),
  nodeEnv: process.env.NODE_ENV,
  webDist,
})

app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`)
  if (webDist) console.log(`Serving the web app from ${webDist}`)
})
