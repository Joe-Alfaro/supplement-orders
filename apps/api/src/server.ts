import express from 'express'
import type { Db } from './db/client'
import { adminRouter } from './http/admin'
import { dashboardRouter } from './http/dashboard'
import { errorHandler } from './http/errors'
import { ordersRouter } from './http/orders'
import { patientsRouter } from './http/patients'
import { productsRouter } from './http/products'
import { spaRouter } from './http/spa'
import { usersRouter } from './http/users'
import type { Auth, Notifier, PaymentGateway } from './seams'
import { HeaderAuth } from './seams'

/** Test-only fault injection points inside the pay transaction. */
/** Test-only scheduling points inside an order detail read (revision 11, N5). */
export interface ReadHooks {
  /** Runs after the order header is read, before its lines and payment. */
  afterOrderHeader?: () => Promise<void>
}

export interface PayHooks {
  /** Runs after the payment's journal is posted, before the order is marked paid. */
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
  readHooks?: ReadHooks
  /** The clock for date-range resolution; defaults to the system clock. */
  now?: () => Date
  /** Built web app to serve outside /api (production); omitted in dev and tests. */
  webDist?: string
}

export interface AppContext {
  db: Db
  gateway: PaymentGateway
  notifier: Notifier
  auth: Auth
  allowSimulatedFailure: boolean
  payHooks: PayHooks
  readHooks: ReadHooks
  now: () => Date
}

export function createApp(deps: AppDeps) {
  const ctx: AppContext = {
    db: deps.db,
    gateway: deps.gateway,
    notifier: deps.notifier,
    auth: deps.auth ?? new HeaderAuth(deps.db),
    allowSimulatedFailure: deps.nodeEnv !== 'production',
    payHooks: deps.payHooks ?? {},
    readHooks: deps.readHooks ?? {},
    now: deps.now ?? (() => new Date()),
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
  app.use('/api/admin', adminRouter(ctx))

  app.use('/api', (_req, res) => {
    res
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
  })
  if (deps.webDist) app.use(spaRouter(deps.webDist))
  app.use(errorHandler)

  return app
}
