import type { ProductDto } from '@supplement-orders/domain'
import { asc } from 'drizzle-orm'
import { Router } from 'express'
import { products } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'

/**
 * Provider only: products carry wholesale cost, which patients never see.
 * Read-only: stock decreases only when an order is paid.
 */
export function productsRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'provider')
    const rows: ProductDto[] = await db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        cogsCents: products.cogsCents,
        stockQuantity: products.stockQuantity,
      })
      .from(products)
      .orderBy(asc(products.name))
    res.json(rows)
  })

  return router
}
