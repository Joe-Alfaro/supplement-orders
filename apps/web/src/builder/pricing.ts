import {
  computePlatformFee,
  formatBps,
  formatCents,
  markupBpsFromPrice,
  minUnitPriceCents,
  parseDollarsToCents,
  parsePercentToBps,
  priceFromMarkupBps,
} from '../money'

// Pure pricing helpers shared by the lines table and the Add-product modal, so
// both link Margin % and Patient price the same way.

/** The product facts a line needs. Stock is unknown for a reloaded draft line. */
export interface LineProduct {
  id: number
  name: string
  sku: string
  cogsCents: number
  stockQuantity: number | null
}

export type PricingField = 'quantity' | 'unitPriceCents' | 'margin'

export interface PricingInputs {
  product: LineProduct | null
  quantityInput: string
  priceInput: string
  marginInput: string
  /** Which of the two linked fields the provider typed in last. */
  source: 'price' | 'margin'
}

export interface PricingResult {
  quantity: number | null
  priceCents: number | null
  minPriceCents: number | null
  belowMinimum: boolean
  lineTotalCents: number | null
  /**
   * The processing fee on this line alone, shown for transparency. The order's
   * fee is computed once on the subtotal and may differ by a cent.
   */
  lineFeeCents: number | null
  errors: Partial<Record<PricingField, string>>
  /** Every typed value parses, so it can be saved (possibly incomplete). */
  saveable: boolean
}

/** Dollar string for an input, e.g. 123450 -> "1,234.50". */
export function centsToInput(cents: number) {
  return formatCents(cents).replace('$', '')
}

export function parsePrice(input: string): {
  cents: number | null
  error?: string
} {
  if (input.trim() === '') return { cents: null }
  const parsed = parseDollarsToCents(input)
  if (!parsed.ok) return { cents: null, error: parsed.error }
  return { cents: parsed.cents }
}

function parseQuantity(input: string, stock: number | null) {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    return { error: 'Enter a whole number of 1 or more' }
  }
  const quantity = Number(trimmed)
  if (stock !== null && quantity > stock) {
    return { error: `Only ${stock} in stock` }
  }
  return { quantity }
}

/** New margin text for a typed price, or null when it can't be derived. */
export function marginInputFromPrice(cogsCents: number, priceInput: string) {
  const price = parsePrice(priceInput)
  if (price.cents === null) return null
  // Revision 5 compile fix: the linked field now carries markup; null at zero cost.
  const bps = markupBpsFromPrice(cogsCents, price.cents)
  return bps === null ? null : formatBps(bps)
}

/** New price text for a typed margin, or null when it can't be derived. */
export function priceInputFromMargin(cogsCents: number, marginInput: string) {
  const margin = parsePercentToBps(marginInput)
  if (!margin.ok) return null
  return centsToInput(priceFromMarkupBps(cogsCents, margin.bps))
}

export function normalizedPriceInput(input: string) {
  const { cents } = parsePrice(input)
  return cents === null ? input : centsToInput(cents)
}

export function normalizedMarginInput(input: string) {
  const margin = parsePercentToBps(input)
  return margin.ok ? formatBps(margin.bps) : input
}

function lineFee(lineTotalCents: number | null) {
  if (lineTotalCents === null) return null
  try {
    return computePlatformFee(lineTotalCents)
  } catch {
    // Only for absurd amounts; the price field already flags them.
    return null
  }
}

/** Price text for a product's minimum price: what a newly chosen product starts at. */
export function minimumPriceInput(cogsCents: number) {
  return centsToInput(minUnitPriceCents(cogsCents))
}

export function evaluatePricing(inputs: PricingInputs): PricingResult {
  const { product } = inputs
  const errors: Partial<Record<PricingField, string>> = {}

  const parsedQuantity = parseQuantity(
    inputs.quantityInput,
    product?.stockQuantity ?? null,
  )
  if (parsedQuantity.error) errors.quantity = parsedQuantity.error
  const quantity = parsedQuantity.quantity ?? null

  const price = parsePrice(inputs.priceInput)
  if (price.error) errors.unitPriceCents = price.error
  const priceCents = price.cents

  // A derived margin can be negative (price below cost); only typed input is validated.
  const marginError =
    inputs.source === 'margin' &&
    inputs.marginInput.trim() !== '' &&
    !parsePercentToBps(inputs.marginInput).ok
  if (marginError) errors.margin = 'Enter a margin from 0 to 99.99'

  const minPriceCents = product ? minUnitPriceCents(product.cogsCents) : null
  const belowMinimum =
    minPriceCents !== null && priceCents !== null && priceCents < minPriceCents
  const lineTotalCents =
    quantity !== null && priceCents !== null ? priceCents * quantity : null

  return {
    lineFeeCents: lineFee(lineTotalCents),
    quantity,
    priceCents,
    minPriceCents,
    belowMinimum,
    lineTotalCents,
    errors,
    saveable: !errors.quantity && !price.error && !marginError,
  }
}
