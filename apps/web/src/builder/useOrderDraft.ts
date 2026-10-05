import type {
  OrderLineInput,
  OrderSplitDto,
  ProviderOrderLineDto,
} from '@supplement-orders/domain'
import { computed, ref } from 'vue'
import { computeSplit } from '../money'
import {
  centsToInput,
  evaluatePricing,
  marginInputFromPrice,
  normalizedMarginInput,
  normalizedPriceInput,
  priceInputFromMargin,
  type LineProduct,
  type PricingResult,
} from './pricing'
import { formatBps } from '../money'

export type LineField = 'productId' | 'quantity' | 'unitPriceCents' | 'margin'

/**
 * One editable row. Inputs stay as strings; the unit price in cents is derived.
 * Margin % and Patient price are two views of that one price: editing either
 * rewrites only the other, never the field being typed in. The product is
 * fixed once chosen; to change it, remove the line and add another.
 */
export interface DraftLine {
  key: number
  product: LineProduct | null
  quantityInput: string
  priceInput: string
  marginInput: string
  source: 'price' | 'margin'
  /** Errors returned by the API for this line, keyed by field. */
  serverErrors: Partial<Record<LineField, string>>
}

export interface EvaluatedLine extends Omit<PricingResult, 'errors'> {
  line: DraftLine
  product: LineProduct | null
  errors: Partial<Record<LineField, string>>
  /** Has a product, a valid quantity, and a price at or above its minimum. */
  complete: boolean
}

/** What the Add-product modal hands over. */
export interface NewLine {
  product: LineProduct
  quantityInput: string
  priceInput: string
  marginInput: string
  source: 'price' | 'margin'
}

let nextKey = 1

function emptyLine(): DraftLine {
  return {
    key: nextKey++,
    product: null,
    quantityInput: '1',
    priceInput: '',
    marginInput: '',
    source: 'price',
    serverErrors: {},
  }
}

function evaluate(line: DraftLine): EvaluatedLine {
  const pricing = evaluatePricing(line)
  return {
    ...pricing,
    line,
    product: line.product,
    // Server messages win: they reflect what the API actually rejected.
    errors: { ...pricing.errors, ...line.serverErrors },
    complete:
      line.product !== null &&
      pricing.quantity !== null &&
      pricing.priceCents !== null &&
      !pricing.belowMinimum &&
      Object.keys(line.serverErrors).length === 0,
  }
}

const LINE_FIELD_PATTERN = /^lines\.(\d+)\.(productId|quantity|unitPriceCents)$/

/** Local draft for the order builder. Money math comes from the shared domain package. */
export function useOrderDraft() {
  const lines = ref<DraftLine[]>([])

  const evaluated = computed(() => lines.value.map(evaluate))

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

  /** Products already on the order; the modal disables them. */
  const productIds = computed(() =>
    lines.value.flatMap((line) => (line.product ? [line.product.id] : [])),
  )

  function find(key: number) {
    return lines.value.find((candidate) => candidate.key === key)
  }

  /** Appends a line from the modal and returns its key. */
  function addLine(newLine: NewLine) {
    const line: DraftLine = { ...emptyLine(), ...newLine }
    lines.value.push(line)
    return line.key
  }

  function removeLine(key: number) {
    lines.value = lines.value.filter((line) => line.key !== key)
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
    if (!line.product) return
    line.marginInput =
      marginInputFromPrice(line.product.cogsCents, input) ?? line.marginInput
  }

  function setMargin(key: number, input: string) {
    const line = find(key)
    if (!line) return
    line.marginInput = input
    line.source = 'margin'
    line.serverErrors = {}
    if (!line.product) return
    line.priceInput =
      priceInputFromMargin(line.product.cogsCents, input) ?? line.priceInput
  }

  /** After the provider leaves a field, normalize it, e.g. "12.5" -> "12.50". */
  function normalizePrice(key: number) {
    const line = find(key)
    if (line) line.priceInput = normalizedPriceInput(line.priceInput)
  }

  function normalizeMargin(key: number) {
    const line = find(key)
    if (line) line.marginInput = normalizedMarginInput(line.marginInput)
  }

  /** Request body for PUT /lines; incomplete parts are sent as null. */
  function toInputs(): OrderLineInput[] {
    return evaluated.value.map((row) => ({
      productId: row.line.product?.id ?? null,
      quantity: row.quantity ?? 1,
      unitPriceCents: row.priceCents,
    }))
  }

  /** Replace local lines with the server's saved version. */
  function loadFromServer(serverLines: readonly ProviderOrderLineDto[]) {
    lines.value = serverLines.map((line) => ({
      ...emptyLine(),
      product: lineProduct(line),
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
    productIds,
    addLine,
    removeLine,
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

function lineProduct(line: ProviderOrderLineDto): LineProduct | null {
  if (
    line.productId === null ||
    line.productName === null ||
    line.sku === null ||
    line.unitCogsCents === null
  ) {
    return null
  }
  return {
    id: line.productId,
    name: line.productName,
    sku: line.sku,
    cogsCents: line.unitCogsCents,
    // Live stock, so Qty on a reloaded line is capped like a freshly added one.
    stockQuantity: line.stockQuantity,
  }
}
