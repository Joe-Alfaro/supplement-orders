import express from 'express'

export interface AppDeps {
  /** Resolves when the database is reachable; rejects otherwise. */
  pingDb: () => Promise<void>
}

export function createApp({ pingDb }: AppDeps) {
  const app = express()
  app.use(express.json())

  app.get('/api/health', async (_req, res) => {
    try {
      await pingDb()
      res.json({ status: 'ok', db: 'ok' })
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable' })
    }
  })

  return app
}
