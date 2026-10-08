import {
  POSTGRES_INTEGER_MAX,
  STOCK_QUANTITY_MAX,
  type AdminProductDto,
} from '@supplement-orders/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { inventoryAdjustments, products } from '../db/schema'
import { ApiError, notFound } from '../http/errors'

// Revision 13: admin stock changes. Each one updates a single product row in a
// single statement, so it cannot deadlock with the payment path's product-id
// lock ordering, and writes its audit row in the same transaction.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export const adminProductColumns = {
  id: products.id,
  name: products.name,
  wholesaleCostCents: products.cogsCents,
  stockQuantity: products.stockQuantity,
}

async function currentStock(reader: Db | Tx, productId: number) {
  const [row] = await reader
    .select({ stockQuantity: products.stockQuantity })
    .from(products)
    .where(eq(products.id, productId))
  if (!row) throw notFound('Product')
  return row.stockQuantity
}

/**
 * Adds `by` atomically: concurrent increments queue on the row lock and each
 * applies on top of the last. 400 on `by` if the result would pass the bound.
 *
 * Revision 17.4: one statement, so the row lock is held for a single round
 * trip. The update and its audit row commit together as before (a statement
 * is atomic), but a burst of increments no longer queues behind a
 * BEGIN/UPDATE/INSERT/COMMIT exchange per caller.
 */
export async function incrementStock(
  db: Db,
  adminUserId: number,
  productId: number,
  by: number,
): Promise<AdminProductDto> {
  const result = await db.execute<{
    id: number
    name: string
    wholesaleCostCents: string
    stockQuantity: number
  }>(sql`
    with updated as (
      update ${products}
      set stock_quantity = stock_quantity + ${by}
      where id = ${productId} and stock_quantity <= ${STOCK_QUANTITY_MAX - by}
      returning id, name, cogs_cents, stock_quantity
    ), audit as (
      insert into ${inventoryAdjustments}
        (product_id, user_id, kind, previous_quantity, new_quantity)
      select id, ${adminUserId}, 'increment', stock_quantity - ${by}, stock_quantity
      from updated
    )
    select id, name, cogs_cents::text as "wholesaleCostCents",
      stock_quantity as "stockQuantity"
    from updated`)
  const [row] = result.rows
  if (row) return { ...row, wholesaleCostCents: Number(row.wholesaleCostCents) }

  const stock = await currentStock(db, productId)
  throw new ApiError(
    400,
    'VALIDATION_ERROR',
    `Stock is ${stock}; adding ${by} would exceed ${STOCK_QUANTITY_MAX}`,
    'by',
  )
}

/**
 * Compare-and-set: stock becomes `stockQuantity` only if it still equals
 * `expected`, which may be any non-negative integer (revision 15.4), so a value
 * above the bound, left by a released reservation, can always be corrected. Otherwise 409 STOCK_CHANGED with the current value, e.g. when a
 * payment reserved stock or another admin changed it after the admin loaded it.
 */
export function setStock(
  db: Db,
  adminUserId: number,
  productId: number,
  stockQuantity: number,
  expected: number,
): Promise<AdminProductDto> {
  return db.transaction(async (tx) => {
    // Revision 15.4: `expected` is unbounded, but no stored stock can exceed
    // the integer column, so a larger value simply doesn't match.
    const [row] =
      expected > POSTGRES_INTEGER_MAX
        ? []
        : await tx
            .update(products)
            .set({ stockQuantity })
            .where(
              and(
                eq(products.id, productId),
                eq(products.stockQuantity, expected),
              ),
            )
            .returning(adminProductColumns)
    if (!row) {
      const current = await currentStock(tx, productId)
      throw new ApiError(
        409,
        'STOCK_CHANGED',
        `Stock changed to ${current} since you loaded it`,
        undefined,
        { currentStockQuantity: current },
      )
    }
    await tx.insert(inventoryAdjustments).values({
      productId,
      userId: adminUserId,
      kind: 'set',
      previousQuantity: expected,
      newQuantity: stockQuantity,
    })
    return row
  })
}
