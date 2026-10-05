import { loadConfig } from './config'
import { createDb } from './db/client'
import { createApp } from './server'

const config = loadConfig()
const { ping } = createDb(config.DATABASE_URL)
const app = createApp({ pingDb: ping })

app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`)
})
