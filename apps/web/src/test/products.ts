import type { ProductDto } from '@supplement-orders/domain'
import { minUnitPriceCents } from '../money'

/** A catalog product before the provider's default is attached. */
export type ProductFixture = Omit<ProductDto, 'defaultUnitPriceCents'>

/** A provider's product row whose default is the minimum, as a fresh seed has it. */
export function atMinimum(
  product: Omit<ProductDto, 'defaultUnitPriceCents'>,
): ProductDto {
  return {
    ...product,
    defaultUnitPriceCents: minUnitPriceCents(product.cogsCents),
  }
}
