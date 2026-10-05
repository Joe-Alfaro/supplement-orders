import type {
  OrderLineInput,
  OrderSplitDto,
  ProductDto,
  ProviderOrderLineDto,
} from '@supplement-orders/domain'
import { computed, ref, type Ref } from 'vue'
import {
  computeSplit,
  formatBps,
  formatCents,
  marginBpsFromPrice,
  minUnitPriceCents,
  parseDollarsToCents,
  parsePercentToBps,
  priceFromMarginBps,
} from '../money'

export type LineField = 'productId' | 'quantity' | 'unitPriceCents' | 'margin'

/**
 * One editable row. Inputs stay as strings; the unit price in cents is derived.
 * Margin % and Patient price are two views of that one price: editing either
 * rewrites only the other, never the field being typed in.
 */
export interface DraftLine {
  key: number
  productId: number | null
  quantityInput: string
  priceInput: string
  marginInput: string
  /** Which of the two linked fields the provider typed in last. */
  source: 'price' | 'margin'
  /** Errors returned by the API for this line, keyed by field. */
  serverErrors: Partial<Record<LineField, string>>
}

export interface EvaluatedLine {
  line: DraftLine
  product: ProductDto | null
  quantity: number | null
  priceCents: number | null
  minPriceCents: number | null
  belowMinimum: boolean
  lineTotalCents: number | null
  errors: Partial<Record<LineField, string>>
  /** Has a product, a valid quantity, and a price at or above its minimum. */
  complete: boolean
  /** Every typed value parses, so the line can be saved (possibly incomplete). */
  saveable: boolean
}

let nextKey = 1

function blankLine(): DraftLine {
  return {
    key: nextKey++,
    productId: null,
    quantityInput: '1',
    priceInput: '',
    marginInput: '',
    source: 'price',
    serverErrors: {},
  }
}

/** Dollar string for an input, e.g. 123450 -> "1,234.50". */
export function centsToInput(cents: number) {
  return formatCents(cents).replace('$', '')
}

function parsePrice(input: string): { cents: number | null; error?: string } {
  if (input.trim() === '') return { cents: null }
  const parsed = parseDollarsToCents(input)
  return parsed.ok
    ? { cents: parsed.cents }
    : { cents: null, error: parsed.error }
}

function parseQuantity(input: string, product: ProductDto | null) {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    return { error: 'Enter a whole number of 1 or more' }
  }
  const quantity = Number(trimmed)
  if (product && quantity > product.stockQuantity) {
    return { error: `Only ${product.stockQuantity} in stock` }
  }
  return { quantity }
}

function evaluate(
  line: DraftLine,
  products: readonly ProductDto[],
): EvaluatedLine {
  const product = products.find((p) => p.id === line.productId) ?? null
  const errors: Partial<Record<LineField, string>> = {}

  const parsedQuantity = parseQuantity(line.quantityInput, product)
  if (parsedQuantity.error) errors.quantity = parsedQuantity.error
  const quantity = parsedQuantity.quantity ?? null

  const price = parsePrice(line.priceInput)
  if (price.error) errors.unitPriceCents = price.error
  const priceCents = price.cents

  // A derived margin can be negative (price below cost); only typed input is validated.
  const marginError =
    line.source === 'margin' &&
    line.marginInput.trim() !== '' &&
    !parsePercentToBps(line.marginInput).ok
  if (marginError) errors.margin = 'Enter a margin from 0 to 99.99'

  const minPriceCents = product ? minUnitPriceCents(product.cogsCents) : null
  const belowMinimum =
    minPriceCents !== null && priceCents !== null && priceCents < minPriceCents
  const lineTotalCents =
    quantity !== null && priceCents !== null ? priceCents * quantity : null

  return {
    line,
    product,
    quantity,
    priceCents,
    minPriceCents,
    belowMinimum,
    lineTotalCents,
    // Server messages win: they reflect what the API actually rejected.
    errors: { ...errors, ...line.serverErrors },
    complete:
      product !== null &&
      quantity !== null &&
      priceCents !== null &&
      !belowMinimum &&
      Object.keys(line.serverErrors).length === 0,
    saveable: !errors.quantity && !price.error && !marginError,
  }
}

const LINE_FIELD_PATTERN = /^lines\.(\d+)\.(productId|quantity|unitPriceCents)$/

/** Local draft for the order builder. Money math comes from the shared domain package. */
export function useOrderDraft(products: Ref<ProductDto[]>) {
  const lines = ref<DraftLine[]>([blankLine()])

  const evaluated = computed(() =>
    lines.value.map((line) => evaluate(line, products.value)),
  )

  const allComplete = computed(
    () =>
      evaluated.value.length > 0 &&
      evaluated.value.every((row) => row.complete),
  )

  /** The shared computeSplit, once every line is complete. */
  const split = computed<OrderSplitDto | null>(() => {
    if (!allComplete.value) return null
    try {
      return computeSplit(
        evaluated.value.map((row) => ({
          quantity: row.quantity ?? 0,
          unitPriceCents: row.priceCents ?? 0,
          unitCogsCents: row.product?.cogsCents ?? 0,
        })),
      )
    } catch {
      // Only reachable for absurd amounts (UNSAFE_AMOUNT); send would reject them too.
      return null
    }
  })

  const canSave = computed(() => evaluated.value.every((row) => row.saveable))
  const canSend = computed(() => split.value !== null)

  function find(key: number) {
    return lines.value.find((candidate) => candidate.key === key)
  }

  function cogsOf(line: DraftLine) {
    return (
      products.value.find((p) => p.id === line.productId)?.cogsCents ?? null
    )
  }

  /** Rewrites the margin field from the current price (never the price field). */
  function syncMarginFromPrice(line: DraftLine) {
    const cogs = cogsOf(line)
    const price = parsePrice(line.priceInput)
    if (cogs === null || price.cents === null) return
    line.marginInput = formatBps(marginBpsFromPrice(cogs, price.cents))
  }

  /** Rewrites the price field from the current margin (never the margin field). */
  function syncPriceFromMargin(line: DraftLine) {
    const cogs = cogsOf(line)
    const margin = parsePercentToBps(line.marginInput)
    if (cogs === null || !margin.ok) return
    line.priceInput = centsToInput(priceFromMarginBps(cogs, margin.bps))
  }

  /** Products not already chosen on another line, plus this line's own product. */
  function optionsFor(line: DraftLine) {
    const taken = new Set(
      lines.value
        .filter((other) => other.key !== line.key)
        .map((other) => other.productId),
    )
    return products.value.filter(
      (product) => product.id === line.productId || !taken.has(product.id),
    )
  }

  function addLine() {
    lines.value.push(blankLine())
  }

  function removeLine(key: number) {
    lines.value = lines.value.filter((line) => line.key !== key)
  }

  function setProduct(key: number, productId: number | null) {
    const line = find(key)
    if (!line) return
    line.productId = productId
    line.serverErrors = {}
    // Keep whichever value the provider already entered; derive the other.
    if (parsePrice(line.priceInput).cents !== null) {
      syncMarginFromPrice(line)
      return
    }
    syncPriceFromMargin(line)
  }

  function setQuantity(key: number, input: string) {
    const line = find(key)
    if (!line) return
    line.quantityInput = input
    line.serverErrors = {}
  }

  function setPrice(key: number, input: string) {
    const line = find(key)
    if (!line) return
    line.priceInput = input
    line.source = 'price'
    line.serverErrors = {}
    syncMarginFromPrice(line)
  }

  function setMargin(key: number, input: string) {
    const line = find(key)
    if (!line) return
    line.marginInput = input
    line.source = 'margin'
    line.serverErrors = {}
    syncPriceFromMargin(line)
  }

  /** After the provider leaves a field, normalize it, e.g. "12.5" -> "12.50". */
  function normalizePrice(key: number) {
    const line = find(key)
    const cents = line ? parsePrice(line.priceInput).cents : null
    if (line && cents !== null) line.priceInput = centsToInput(cents)
  }

  function normalizeMargin(key: number) {
    const line = find(key)
    if (!line) return
    const margin = parsePercentToBps(line.marginInput)
    if (margin.ok) line.marginInput = formatBps(margin.bps)
  }

  /** Request body for PUT /lines; incomplete parts are sent as null. */
  function toInputs(): OrderLineInput[] {
    return evaluated.value.map((row) => ({
      productId: row.line.productId,
      quantity: row.quantity ?? 1,
      unitPriceCents: row.priceCents,
    }))
  }

  /** Replace local lines with the server's saved version. */
  function loadFromServer(serverLines: readonly ProviderOrderLineDto[]) {
    lines.value = serverLines.map((line) => ({
      ...blankLine(),
      productId: line.productId,
      quantityInput: String(line.quantity),
      priceInput:
        line.unitPriceCents === null ? '' : centsToInput(line.unitPriceCents),
      marginInput: line.marginBps === null ? '' : formatBps(line.marginBps),
    }))
  }

  /** Places an API error next to its field. Returns false when it has no line field. */
  function applyFieldError(field: string | undefined, message: string) {
    const match = field ? LINE_FIELD_PATTERN.exec(field) : null
    if (!match) return false
    const line = lines.value[Number(match[1])]
    if (!line) return false
    line.serverErrors = { [match[2] as LineField]: message }
    return true
  }

  return {
    lines,
    evaluated,
    split,
    canSave,
    canSend,
    optionsFor,
    addLine,
    removeLine,
    setProduct,
    setQuantity,
    setPrice,
    setMargin,
    normalizePrice,
    normalizeMargin,
    toInputs,
    loadFromServer,
    applyFieldError,
  }
}
