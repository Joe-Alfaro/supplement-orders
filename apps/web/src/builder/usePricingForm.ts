import { computed, reactive, ref, type Ref } from 'vue'
import { formatCents } from '../money'
import {
  evaluatePricing,
  markupInputFromPrice,
  normalizedMarkupInput,
  normalizedPriceInput,
  priceInputFromMarkup,
  type LineProduct,
} from './pricing'

export interface PricingFormError {
  id: string
  label: string
  text: string
}

export interface PricingFormOptions {
  /** Prefix of the error ids, which the inputs' aria-describedby point at. */
  idPrefix: string
  /** Qty is not an input: the price is for one unit. */
  fixedQuantity?: boolean
  /** A blank price is an error once the provider tries to save. */
  requirePrice?: boolean
}

export interface PricingValues {
  quantityInput: string
  priceInput: string
  markupInput: string
  source: 'price' | 'markup'
}

/**
 * The linked Markup % / Patient price state shared by the add/edit-line dialog
 * and the dashboard's default-price dialog, so both price a unit the same way
 * and list errors the same way (§4.4d).
 */
export function usePricingForm(
  product: Ref<LineProduct | null>,
  options: PricingFormOptions,
) {
  const quantityInput = ref('1')
  const priceInput = ref('')
  const markupInput = ref('')
  const source = ref<'price' | 'markup'>('price')
  const attempted = ref(false)

  const pricing = computed(() =>
    evaluatePricing({
      product: product.value,
      quantityInput: quantityInput.value,
      priceInput: priceInput.value,
      markupInput: markupInput.value,
      source: source.value,
    }),
  )

  const belowMinimumError = computed(() => {
    const { belowMinimum, minPriceCents } = pricing.value
    if (!belowMinimum || minPriceCents === null) return null
    return `Price must be at least ${formatCents(minPriceCents)}`
  })

  const blankPriceError = computed(() => {
    const blank =
      pricing.value.priceCents === null && !pricing.value.errors.unitPriceCents
    return options.requirePrice && attempted.value && blank
      ? 'Enter a price'
      : null
  })

  const priceError = computed(
    () =>
      pricing.value.errors.unitPriceCents ??
      blankPriceError.value ??
      (attempted.value ? belowMinimumError.value : null),
  )

  /** One entry per invalid input, in field order. */
  const errorItems = computed<PricingFormError[]>(() => {
    const { quantity, markup } = pricing.value.errors
    const prefix = options.idPrefix
    const candidates: Array<PricingFormError | null> = [
      quantity && !options.fixedQuantity
        ? { id: `${prefix}-qty-error`, label: 'Qty', text: quantity }
        : null,
      markup
        ? { id: `${prefix}-markup-error`, label: 'Markup %', text: markup }
        : null,
      priceError.value
        ? {
            id: `${prefix}-price-error`,
            label: 'Patient price (each)',
            text: priceError.value,
          }
        : null,
    ]
    return candidates.filter((item): item is PricingFormError => item !== null)
  })

  /** Markup on a $0 wholesale cost is undefined: the field shows "—" and is disabled. */
  const zeroCost = computed(() => product.value?.cogsCents === 0)

  function onQuantity(value: string) {
    quantityInput.value = value
  }

  function onPrice(value: string) {
    priceInput.value = value
    source.value = 'price'
    if (!product.value) return
    markupInput.value =
      markupInputFromPrice(product.value.cogsCents, value) ?? markupInput.value
  }

  function onMarkup(value: string) {
    markupInput.value = value
    source.value = 'markup'
    if (!product.value) return
    priceInput.value =
      priceInputFromMarkup(product.value.cogsCents, value) ?? priceInput.value
  }

  function normalizeMarkup() {
    markupInput.value = normalizedMarkupInput(markupInput.value)
  }

  function normalizePrice() {
    priceInput.value = normalizedPriceInput(priceInput.value)
  }

  /** Loads exact values, e.g. a line being edited. */
  function load(values: PricingValues) {
    quantityInput.value = values.quantityInput
    priceInput.value = values.priceInput
    markupInput.value = values.markupInput
    source.value = values.source
    attempted.value = false
  }

  /** Starts at a price for a unit; the markup follows from it. */
  function startAtPrice(chosen: LineProduct, price: string) {
    load({
      quantityInput: '1',
      priceInput: price,
      markupInput: markupInputFromPrice(chosen.cogsCents, price) ?? '',
      source: 'price',
    })
  }

  function values(): PricingValues {
    return {
      quantityInput: quantityInput.value,
      priceInput: priceInput.value,
      markupInput: markupInput.value,
      source: source.value,
    }
  }

  return reactive({
    quantityInput,
    priceInput,
    markupInput,
    source,
    attempted,
    pricing,
    belowMinimumError,
    priceError,
    errorItems,
    zeroCost,
    onQuantity,
    onPrice,
    onMarkup,
    normalizeMarkup,
    normalizePrice,
    load,
    startAtPrice,
    values,
  })
}

export type PricingForm = ReturnType<typeof usePricingForm>
