import { loadConfig } from './config'
import { createDb } from './db/client'
import { ConsoleNotifier, FakePaymentGateway } from './seams'
import { createApp } from './server'

const config = loadConfig()
const { db, ping } = createDb(config.DATABASE_URL)
const app = createApp({
  db,
  pingDb: ping,
  gateway: new FakePaymentGateway(),
  notifier: new ConsoleNotifier(),
  nodeEnv: process.env.NODE_ENV,
})

app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`)
})
