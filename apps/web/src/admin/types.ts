import type { Page } from '@supplement-orders/domain'

// Local copies of the revision 13 contract (DOMAIN_CONTRACT "Revision 13").
// Replace with the @supplement-orders/domain types once the API branch is merged.

/** One row of GET /api/admin/products. */
export interface AdminProductDto {
  id: number
  name: string
  wholesaleCostCents: number
  stockQuantity: number
}

export type AdminProductPageDto = Page<AdminProductDto>

/** Stock bounds enforced by the API (inclusive). */
export const MIN_STOCK = 0
export const MAX_STOCK = 1_000_000

/** Users now include the admin role, which the shared Role type lacks. */
export type AppRole = 'provider' | 'patient' | 'admin'
