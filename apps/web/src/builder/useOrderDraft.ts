import type {
  OrderLineInput,
  OrderSplitDto,
  ProductDto,
  ProviderOrderLineDto,
} from '@supplement-orders/domain'
import { computed, ref, type Ref } from 'vue'
import {
  computeSplit,
  formatCents,
  parseDollarsToCents,
  SplitValidationError,
} from '../money'

export type LineField = 'productId' | 'quantity' | 'unitPriceCents'

/** One editable row. Inputs stay as strings; cents are derived. */
export interface DraftLine {
  key: number
  productId: number | null
  quantityInput: string
  priceInput: string
  priceTouched: boolean
  /** Errors returned by the API for this line, keyed by request field. */
  serverErrors: Partial<Record<LineField, string>>
}

export interface EvaluatedLine {
  line: DraftLine
  product: ProductDto | null
  quantity: number | null
  priceCents: number | null
  marginCents: number | null
  lineTotalCents: number | null
  errors: Partial<Record<LineField, string>>
  complete: boolean
}

let nextKey = 1

function blankLine(): DraftLine {
  return {
    key: nextKey++,
    productId: null,
    quantityInput: '1',
    priceInput: '',
    priceTouched: false,
    serverErrors: {},
  }
}

/** Dollar string for an input, e.g. 1234.5 dollars -> "1,234.50". */
export function centsToInput(cents: number) {
  return formatCents(cents).replace('$', '')
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
  showAllErrors: boolean,
): EvaluatedLine {
  const product = products.find((p) => p.id === line.productId) ?? null
  const errors: Partial<Record<LineField, string>> = {}

  if (!product && showAllErrors) errors.productId = 'Choose a product'

  const parsedQuantity = parseQuantity(line.quantityInput, product)
  if (parsedQuantity.error) errors.quantity = parsedQuantity.error
  const quantity = parsedQuantity.quantity ?? null

  const parsedPrice = parseDollarsToCents(line.priceInput)
  const priceCents = parsedPrice.ok ? parsedPrice.cents : null
  if (!parsedPrice.ok && (line.priceTouched || showAllErrors)) {
    errors.unitPriceCents =
      line.priceInput.trim() === '' ? 'Enter a price' : parsedPrice.error
  }

  const marginCents =
    product && priceCents !== null ? priceCents - product.cogsCents : null
  const lineTotalCents =
    quantity !== null && priceCents !== null ? priceCents * quantity : null

  return {
    line,
    product,
    quantity,
    priceCents,
    marginCents,
    lineTotalCents,
    // Server messages win: they reflect what the API actually rejected.
    errors: { ...errors, ...line.serverErrors },
    complete: product !== null && quantity !== null && priceCents !== null,
  }
}

function splitProblem(err: SplitValidationError) {
  const lineNumber = (err.lineIndex ?? 0) + 1
  if (err.code === 'PRICE_BELOW_COGS') {
    return `Line ${lineNumber} is priced below our cost. Raise its price to see the split.`
  }
  return err.message
}

const LINE_FIELD_PATTERN = /^lines\.(\d+)\.(productId|quantity|unitPriceCents)$/

/** Local draft for the order builder. Split math comes from the shared domain package. */
export function useOrderDraft(products: Ref<ProductDto[]>) {
  const lines = ref<DraftLine[]>([blankLine()])
  const showAllErrors = ref(false)

  const evaluated = computed(() =>
    lines.value.map((line) =>
      evaluate(line, products.value, showAllErrors.value),
    ),
  )

  const split = computed<
    { ok: true; split: OrderSplitDto } | { ok: false; message: string }
  >(() => {
    const complete = evaluated.value.filter((row) => row.complete)
    if (complete.length === 0) {
      return {
        ok: false,
        message: 'Add a product and a price to see the split.',
      }
    }
    try {
      const result = computeSplit(
        complete.map((row) => ({
          quantity: row.quantity ?? 0,
          unitPriceCents: row.priceCents ?? 0,
          unitCogsCents: row.product?.cogsCents ?? 0,
        })),
      )
      return { ok: true, split: result }
    } catch (err) {
      if (err instanceof SplitValidationError) {
        return { ok: false, message: splitProblem(err) }
      }
      throw err
    }
  })

  const allComplete = computed(() =>
    evaluated.value.every(
      (row) => row.complete && Object.keys(row.errors).length === 0,
    ),
  )
  const hasNegativeMargin = computed(() =>
    evaluated.value.some(
      (row) => row.marginCents !== null && row.marginCents < 0,
    ),
  )
  const canSaveDraft = computed(() => allComplete.value)
  const canSend = computed(
    () =>
      lines.value.length > 0 &&
      allComplete.value &&
      !hasNegativeMargin.value &&
      split.value.ok,
  )

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

  function updateLine(key: number, patch: Partial<DraftLine>) {
    const line = lines.value.find((candidate) => candidate.key === key)
    if (!line) return
    Object.assign(line, patch, { serverErrors: {} })
  }

  /** Normalizes a valid price on blur, e.g. "12.5" -> "12.50". */
  function blurPrice(key: number) {
    const line = lines.value.find((candidate) => candidate.key === key)
    if (!line) return
    line.priceTouched = true
    const parsed = parseDollarsToCents(line.priceInput)
    if (parsed.ok) line.priceInput = centsToInput(parsed.cents)
  }

  /** Request body for PUT /lines. Only call when canSaveDraft is true. */
  function toInputs(): OrderLineInput[] {
    return evaluated.value.map((row) => ({
      productId: row.product?.id ?? 0,
      quantity: row.quantity ?? 0,
      unitPriceCents: row.priceCents ?? 0,
    }))
  }

  /** Replace local lines with the server's saved version. */
  function loadFromServer(serverLines: readonly ProviderOrderLineDto[]) {
    lines.value = serverLines.map((line) => ({
      ...blankLine(),
      productId: line.productId,
      quantityInput: String(line.quantity),
      priceInput: centsToInput(line.unitPriceCents),
      priceTouched: true,
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
    showAllErrors,
    canSaveDraft,
    canSend,
    optionsFor,
    addLine,
    removeLine,
    updateLine,
    blurPrice,
    toInputs,
    loadFromServer,
    applyFieldError,
  }
}
