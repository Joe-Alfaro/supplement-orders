import express from 'express'
import type { Db } from './db/client'
import { dashboardRouter } from './http/dashboard'
import { errorHandler } from './http/errors'
import { ordersRouter } from './http/orders'
import { patientsRouter } from './http/patients'
import { productsRouter } from './http/products'
import { usersRouter } from './http/users'
import type { Auth, Notifier, PaymentGateway } from './seams'
import { HeaderAuth } from './seams'

/** Test-only fault injection points inside the pay transaction. */
export interface PayHooks {
  /** Runs after the ledger rows are inserted, before the order is marked paid. */
  afterLedgerInsert?: () => Promise<void>
}

export interface AppDeps {
  db: Db
  gateway: PaymentGateway
  notifier: Notifier
  /** Defaults to the X-User-Id header auth backed by `db`. */
  auth?: Auth
  /** Resolves when the database is reachable; rejects otherwise. */
  pingDb: () => Promise<void>
  /** `simulateFailure` on pay is ignored when this is 'production'. */
  nodeEnv?: string
  payHooks?: PayHooks
}

export interface AppContext {
  db: Db
  gateway: PaymentGateway
  notifier: Notifier
  auth: Auth
  allowSimulatedFailure: boolean
  payHooks: PayHooks
}

export function createApp(deps: AppDeps) {
  const ctx: AppContext = {
    db: deps.db,
    gateway: deps.gateway,
    notifier: deps.notifier,
    auth: deps.auth ?? new HeaderAuth(deps.db),
    allowSimulatedFailure: deps.nodeEnv !== 'production',
    payHooks: deps.payHooks ?? {},
  }

  const app = express()
  app.use(express.json())

  app.get('/api/health', async (_req, res) => {
    try {
      await deps.pingDb()
      res.json({ status: 'ok', db: 'ok' })
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable' })
    }
  })

  app.use('/api/users', usersRouter(ctx))
  app.use('/api/products', productsRouter(ctx))
  app.use('/api/patients', patientsRouter(ctx))
  app.use('/api/orders', ordersRouter(ctx))
  app.use('/api/dashboard', dashboardRouter(ctx))

  app.use('/api', (_req, res) => {
    res
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
  })
  app.use(errorHandler)

  return app
}
