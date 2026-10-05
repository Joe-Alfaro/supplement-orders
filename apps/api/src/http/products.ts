import { updateStockRequestSchema, type ProductDto } from '@supplement-orders/domain'
import { asc, eq } from 'drizzle-orm'
import { Router } from 'express'
import { products } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { notFound } from './errors'
import { parseId, parseOrThrow } from './validate'

const productColumns = {
  id: products.id,
  sku: products.sku,
  name: products.name,
  cogsCents: products.cogsCents,
  stockQuantity: products.stockQuantity,
}

/** Provider only: products carry COGS, which patients never see. */
export function productsRouter({ db, auth }: AppContext) {
  const router = Router()

  router.get('/', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'provider')
    const rows: ProductDto[] = await db
      .select(productColumns)
      .from(products)
      .orderBy(asc(products.name))
    res.json(rows)
  })

  router.patch('/:id/stock', async (req, res) => {
    requireRole(await auth.getCurrentUser(req), 'provider')
    const id = parseId(req.params.id)
    const { stockQuantity } = parseOrThrow(updateStockRequestSchema, req.body)
    const [row] = await db
      .update(products)
      .set({ stockQuantity })
      .where(eq(products.id, id))
      .returning(productColumns)
    if (!row) throw notFound('Product')
    const body: ProductDto = row
    res.json(body)
  })

  return router
}
