import type { ProductDto } from '@supplement-orders/domain'
import type { ProviderProductDto } from '../api'
import { minUnitPriceCents } from '../money'

/** A provider's product row whose default is the minimum, as a fresh seed has it. */
export function atMinimum(product: ProductDto): ProviderProductDto {
  return {
    ...product,
    defaultUnitPriceCents: minUnitPriceCents(product.cogsCents),
  }
}
