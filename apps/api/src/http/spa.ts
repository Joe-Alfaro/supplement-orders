import { join } from 'node:path'
import express from 'express'

/**
 * Serves the built Vue app from `distDir`. Mount it after every /api route.
 * Vite fingerprints everything under /assets, so those files can be cached
 * forever. index.html is revalidated on each load so a deploy takes effect
 * immediately. Any other GET falls back to index.html for client-side routes.
 */
export function spaRouter(distDir: string) {
  const indexHtml = join(distDir, 'index.html')
  const router = express.Router()

  router.use(
    '/assets',
    express.static(join(distDir, 'assets'), {
      index: false,
      immutable: true,
      maxAge: '1y',
    }),
    // A missing chunk must not be answered with HTML.
    (_req, res) => {
      res.sendStatus(404)
    },
  )
  router.use(express.static(distDir, { index: false }))
  router.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(indexHtml)
  })

  return router
}
