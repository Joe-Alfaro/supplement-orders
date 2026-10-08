import {
  listProductsQuerySchema,
  type ProductPageDto,
} from '@supplement-orders/domain'
import { asc, count } from 'drizzle-orm'
import { Router } from 'express'
import { products } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { matchesSearch } from './search'
import { parseOrThrow } from './validate'

/**
 * Provider only: products carry wholesale cost, which patients never see.
 * Read-only: stock decreases only when an order is paid.
 */
export function productsRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'provider')
    const { q, offset, limit } = parseOrThrow(
      listProductsQuerySchema,
      req.query,
    )
    const where = matchesSearch(q, [products.name, products.sku])

    const [items, [counted]] = await Promise.all([
      db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          cogsCents: products.cogsCents,
          stockQuantity: products.stockQuantity,
        })
        .from(products)
        .where(where)
        .orderBy(asc(products.name), asc(products.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(products).where(where),
    ])
    const body: ProductPageDto = {
      items,
      total: counted?.total ?? 0,
      offset,
      limit,
    }
    res.json(body)
  })

  return router
}
