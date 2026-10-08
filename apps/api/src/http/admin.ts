import {
  incrementStockRequestSchema,
  listAdminJournalsQuerySchema,
  listAdminPaymentAttemptsQuerySchema,
  listAdminProductsQuerySchema,
  setStockRequestSchema,
  type AdminJournalPageDto,
  type AdminProductPageDto,
  type AdminPaymentAttemptDto,
  type AdminTrialBalanceDto,
  type ReconcilePaymentAttemptDto,
} from '@supplement-orders/domain'
import { asc, count } from 'drizzle-orm'
import { Router } from 'express'
import { products } from '../db/schema'
import {
  adminProductColumns,
  incrementStock,
  setStock,
} from '../inventory/service'
import { listJournals, trialBalance } from '../ledger/journals'
import { reconcileAttempt } from '../orders/service'
import { findPaymentAttempt, listPaymentAttempts } from '../payments/attempts'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { matchesSearch } from './search'
import { parseId, parseOrThrow } from './validate'

/**
 * Revision 13: admin only. The admin manages available stock. Revision 16 adds
 * the read-only ledger: the trial balance and the journal list. Revision 18.2
 * adds payment attempts needing attention and their reconcile action.
 */
export function adminRouter(ctx: AppContext) {
  const { db, auth, now } = ctx
  const router = Router()

  router.get('/products', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'admin')
    const { q, offset, limit } = parseOrThrow(
      listAdminProductsQuerySchema,
      req.query,
    )
    const where = matchesSearch(q, [products.name])

    const [items, [counted]] = await Promise.all([
      db
        .select(adminProductColumns)
        .from(products)
        .where(where)
        .orderBy(asc(products.name), asc(products.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(products).where(where),
    ])
    const body: AdminProductPageDto = {
      items,
      total: counted?.total ?? 0,
      offset,
      limit,
    }
    res.json(body)
  })

  router.post('/products/:id/stock/increment', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'admin')
    const productId = parseId(req.params.id)
    const { by } = parseOrThrow(incrementStockRequestSchema, req.body)
    res.json(await incrementStock(db, user.userId, productId, by))
  })

  router.put('/products/:id/stock', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'admin')
    const productId = parseId(req.params.id)
    const { stockQuantity, expectedStockQuantity } = parseOrThrow(
      setStockRequestSchema,
      req.body,
    )
    res.json(
      await setStock(
        db,
        user.userId,
        productId,
        stockQuantity,
        expectedStockQuantity,
      ),
    )
  })

  router.get('/accounts', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'admin')
    const body: AdminTrialBalanceDto = await trialBalance(db)
    res.json(body)
  })

  router.get('/journals', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'admin')
    const { offset, limit } = parseOrThrow(
      listAdminJournalsQuerySchema,
      req.query,
    )
    const body: AdminJournalPageDto = await listJournals(db, offset, limit)
    res.json(body)
  })

  router.get('/payment-attempts', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'admin')
    const { status } = parseOrThrow(
      listAdminPaymentAttemptsQuerySchema,
      req.query,
    )
    const body: AdminPaymentAttemptDto[] = await listPaymentAttempts(
      db,
      now(),
      status,
    )
    res.json(body)
  })

  router.post('/payment-attempts/:id/reconcile', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'admin')
    const attemptId = parseId(req.params.id)
    const outcome = await reconcileAttempt(ctx, user, attemptId)
    const attempt = await findPaymentAttempt(db, now(), attemptId)
    if (!attempt) throw new Error(`Payment attempt ${attemptId} disappeared`)
    const body: ReconcilePaymentAttemptDto = { outcome, attempt }
    res.json(body)
  })

  return router
}
