import {
  listProductsQuerySchema,
  minDefaultPriceCents,
  setDefaultPriceRequestSchema,
  type ProductDto,
  type ProductPageDto,
} from '@supplement-orders/domain'
import { and, asc, count, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import type { Db } from '../db/client'
import { products, providerProductPrices } from '../db/schema'
import { requireRole } from '../seams'
import type { AppContext } from '../server'
import { ApiError, notFound } from './errors'
import { matchesSearch } from './search'
import { parseId, parseOrThrow } from './validate'

/**
 * Provider only: products carry wholesale cost, which patients never see.
 * Stock is read-only here: it decreases only when an order is paid. Revision
 * 20 adds the calling provider's default patient price per product.
 */
export function productsRouter({ db, auth }: AppContext) {
  const router = Router()

  const productColumns = {
    id: products.id,
    sku: products.sku,
    name: products.name,
    cogsCents: products.cogsCents,
    stockQuantity: products.stockQuantity,
    defaultUnitPriceCents: providerProductPrices.unitPriceCents,
  }

  /** One product row with the provider's default; null for an unknown product. */
  async function findProduct(
    reader: Pick<Db, 'select'>,
    providerId: number,
    productId: number,
  ): Promise<ProductDto | null> {
    const [row] = await reader
      .select(productColumns)
      .from(products)
      .innerJoin(
        providerProductPrices,
        and(
          eq(providerProductPrices.productId, products.id),
          eq(providerProductPrices.providerId, providerId),
        ),
      )
      .where(eq(products.id, productId))
    return row ?? null
  }

  router.get('/', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const { q, offset, limit } = parseOrThrow(
      listProductsQuerySchema,
      req.query,
    )
    const where = matchesSearch(q, [products.name, products.sku])

    const [items, [counted]] = await Promise.all([
      db
        .select(productColumns)
        .from(products)
        .innerJoin(
          providerProductPrices,
          and(
            eq(providerProductPrices.productId, products.id),
            eq(providerProductPrices.providerId, user.providerId),
          ),
        )
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

  /** Validates against the product's minimum, upserts, and returns the row. */
  async function writeDefault(
    providerId: number,
    productId: number,
    unitPriceCents: number | 'minimum',
  ) {
    const [cost] = await db
      .select({ cogsCents: products.cogsCents })
      .from(products)
      .where(eq(products.id, productId))
    if (!cost) throw notFound('Product')
    const minimum = minDefaultPriceCents(cost.cogsCents)
    const price = unitPriceCents === 'minimum' ? minimum : unitPriceCents
    if (price < minimum) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Price must be at least the minimum of ${minimum} cents`,
        'unitPriceCents',
      )
    }
    await db
      .insert(providerProductPrices)
      .values({ providerId, productId, unitPriceCents: price })
      .onConflictDoUpdate({
        target: [
          providerProductPrices.providerId,
          providerProductPrices.productId,
        ],
        set: { unitPriceCents: price, updatedAt: sql`now()` },
      })
    const row = await findProduct(db, providerId, productId)
    if (!row) throw notFound('Product')
    return row
  }

  router.put('/:id/default-price', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const productId = parseId(req.params.id)
    const { unitPriceCents } = parseOrThrow(
      setDefaultPriceRequestSchema,
      req.body,
    )
    const body: ProductDto = await writeDefault(
      user.providerId,
      productId,
      unitPriceCents,
    )
    res.json(body)
  })

  router.post('/:id/default-price/reset', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const productId = parseId(req.params.id)
    const body: ProductDto = await writeDefault(
      user.providerId,
      productId,
      'minimum',
    )
    res.json(body)
  })

  return router
}
