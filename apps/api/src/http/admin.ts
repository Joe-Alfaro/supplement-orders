import {
  incrementStockRequestSchema,
  listAdminProductsQuerySchema,
  setStockRequestSchema,
  type AdminProductPageDto,
} from '@supplement-orders/domain'
import { asc, count } from 'drizzle-orm'
import { Router } from 'express'
import { products } from '../db/schema'
import {
  adminProductColumns,
  incrementStock,
  setStock,
} from '../inventory/service'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { matchesSearch } from './search'
import { parseId, parseOrThrow } from './validate'

/** Revision 13: admin only. The admin manages available stock. */
export function adminRouter({ db, auth }: AppContext) {
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

  return router
}
