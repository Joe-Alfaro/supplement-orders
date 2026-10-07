import { MAX_LINE_QUANTITY, MAX_UNIT_PRICE_CENTS } from '@supplement-orders/domain'
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
// both link Markup % and Patient price the same way.

/** The product facts a line needs. Stock is unknown for a reloaded draft line. */
export interface LineProduct {
  id: number
  name: string
  sku: string
  cogsCents: number
  stockQuantity: number | null
}

export type PricingField = 'quantity' | 'unitPriceCents' | 'markup'

export interface PricingInputs {
  product: LineProduct | null
  quantityInput: string
  priceInput: string
  markupInput: string
  /** Which of the two linked fields the provider typed in last. */
  source: 'price' | 'markup'
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
  /**
   * The provider's margin on this line alone: line total - qty x cost - line
   * fee. Negative below the minimum. The order's margin comes from the whole
   * subtotal and may differ by a cent.
   */
  lineMarginCents: number | null
  errors: Partial<Record<PricingField, string>>
  /** "Only N in stock" when the quantity is over stock: a warning, not an error. */
  stockWarning: string | null
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
  // Revision 9 draft bound: the server rejects anything above $10,000 per unit.
  if (parsed.cents > MAX_UNIT_PRICE_CENTS) {
    return {
      cents: null,
      error: `Price can be at most ${formatCents(MAX_UNIT_PRICE_CENTS)}`,
    }
  }
  return { cents: parsed.cents }
}

function parseQuantity(input: string) {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    return { error: 'Enter a whole number of 1 or more' }
  }
  const quantity = Number(trimmed)
  // Revision 9 draft bound, checked before stock so huge values read clearly.
  if (quantity > MAX_LINE_QUANTITY) {
    return { error: `Enter a quantity of at most ${MAX_LINE_QUANTITY}` }
  }
  return { quantity }
}

/**
 * New Markup % text for a typed price (net of the processing fee, on wholesale
 * cost), or null when it can't be derived, including a $0 cost.
 */
export function markupInputFromPrice(cogsCents: number, priceInput: string) {
  const price = parsePrice(priceInput)
  if (price.cents === null) return null
  const bps = markupBpsFromPrice(cogsCents, price.cents)
  return bps === null ? null : formatBps(bps)
}

/** New price text for a typed Markup %, or null when it can't be derived. */
export function priceInputFromMarkup(cogsCents: number, markupInput: string) {
  // Markup on a $0 cost is undefined; the field is disabled and only price is entered.
  if (cogsCents === 0) return null
  const markup = parsePercentToBps(markupInput)
  if (!markup.ok) return null
  try {
    return centsToInput(priceFromMarkupBps(cogsCents, markup.bps))
  } catch {
    // A markup so large the price isn't a safe integer: leave the price as is.
    return null
  }
}

export function normalizedPriceInput(input: string) {
  const { cents } = parsePrice(input)
  return cents === null ? input : centsToInput(cents)
}

export function normalizedMarkupInput(input: string) {
  const markup = parsePercentToBps(input)
  return markup.ok ? formatBps(markup.bps) : input
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

function lineMargin(
  lineTotalCents: number | null,
  lineFeeCents: number | null,
  quantity: number | null,
  product: LineProduct | null,
) {
  if (
    lineTotalCents === null ||
    lineFeeCents === null ||
    quantity === null ||
    product === null
  ) {
    return null
  }
  return lineTotalCents - quantity * product.cogsCents - lineFeeCents
}

/** Price text for a product's minimum price: what a newly chosen product starts at. */
export function minimumPriceInput(cogsCents: number) {
  return centsToInput(minUnitPriceCents(cogsCents))
}

export function evaluatePricing(inputs: PricingInputs): PricingResult {
  const { product } = inputs
  const errors: Partial<Record<PricingField, string>> = {}

  const parsedQuantity = parseQuantity(inputs.quantityInput)
  if (parsedQuantity.error) errors.quantity = parsedQuantity.error
  const quantity = parsedQuantity.quantity ?? null
  // Revision 14: more than the stock is allowed; the provider is warned instead.
  const stock = product?.stockQuantity ?? null
  const stockWarning =
    quantity !== null && stock !== null && quantity > stock
      ? `Only ${stock} in stock`
      : null

  const price = parsePrice(inputs.priceInput)
  if (price.error) errors.unitPriceCents = price.error
  const priceCents = price.cents

  // A derived markup can be negative (price below cost plus fee); only typed input is validated.
  const parsedMarkup =
    inputs.source === 'markup' && inputs.markupInput.trim() !== ''
      ? parsePercentToBps(inputs.markupInput)
      : null
  const markupError = parsedMarkup !== null && !parsedMarkup.ok
  if (parsedMarkup && !parsedMarkup.ok) errors.markup = parsedMarkup.error

  const minPriceCents = product ? minUnitPriceCents(product.cogsCents) : null
  const belowMinimum =
    minPriceCents !== null && priceCents !== null && priceCents < minPriceCents
  const lineTotalCents =
    quantity !== null && priceCents !== null ? priceCents * quantity : null

  const lineFeeCents = lineFee(lineTotalCents)

  return {
    lineFeeCents,
    lineMarginCents: lineMargin(
      lineTotalCents,
      lineFeeCents,
      quantity,
      product,
    ),
    quantity,
    priceCents,
    minPriceCents,
    belowMinimum,
    lineTotalCents,
    errors,
    stockWarning,
    saveable: !errors.quantity && !price.error && !markupError,
  }
}
