import { z } from 'zod'
import { minUnitPriceCents } from '../money'

/** Revision 20.1: a default patient price is at most this many cents. */
export const DEFAULT_PRICE_MAX_CENTS = 1_000_000

/**
 * The lowest default a provider can have for a product: its minimum unit
 * price, or one cent for a free product (the stored price is at least 1).
 */
export function minDefaultPriceCents(unitCogsCents: number): number {
  return Math.max(1, minUnitPriceCents(unitCogsCents))
}

/**
 * PUT /api/products/:id/default-price (provider only). The minimum depends on
 * the product's cost, so the API checks it after this shape check; a price
 * below it is a 400 VALIDATION_ERROR on `unitPriceCents` naming the minimum.
 */
export interface SetDefaultPriceRequest {
  unitPriceCents: number
}

export const setDefaultPriceRequestSchema: z.ZodType<SetDefaultPriceRequest> =
  z.strictObject({
    unitPriceCents: z.int().min(1).max(DEFAULT_PRICE_MAX_CENTS),
  })
