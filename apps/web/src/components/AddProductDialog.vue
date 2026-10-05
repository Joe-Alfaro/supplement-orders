<script setup lang="ts">
import type { ProductDto } from '@supplement-orders/domain'
import { computed, nextTick, ref, watch } from 'vue'
import { searchProducts } from '../api'
import {
  evaluatePricing,
  marginInputFromPrice,
  normalizedMarginInput,
  normalizedPriceInput,
  priceInputFromMargin,
  type NewLine,
} from '../builder'
import { formatCents } from '../money'
import { usePagedSearch } from '../search'
import ErrorBanner from './ErrorBanner.vue'
import MoneyText from './MoneyText.vue'
import PaginationControls from './PaginationControls.vue'

interface Props {
  open: boolean
  /** Products already on the order; shown as "Already added" and disabled. */
  excludedProductIds: number[]
}

const props = defineProps<Props>()
const emit = defineEmits<{ close: []; add: [line: NewLine] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const quantityInputEl = ref<HTMLInputElement | null>(null)

const search = usePagedSearch(searchProducts)

const step = ref<1 | 2>(1)
const chosen = ref<ProductDto | null>(null)
const quantityInput = ref('1')
const priceInput = ref('')
const marginInput = ref('')
const source = ref<'price' | 'margin'>('price')
const attempted = ref(false)

function unavailableReason(product: ProductDto) {
  if (props.excludedProductIds.includes(product.id)) return 'Already added'
  if (product.stockQuantity === 0) return 'Out of stock'
  return null
}

const pricing = computed(() =>
  evaluatePricing({
    product: chosen.value,
    quantityInput: quantityInput.value,
    priceInput: priceInput.value,
    marginInput: marginInput.value,
    source: source.value,
  }),
)

const belowMinimumError = computed(() => {
  const { belowMinimum, minPriceCents } = pricing.value
  if (!belowMinimum || minPriceCents === null) return null
  return `Price must be at least ${formatCents(minPriceCents)}`
})

const priceError = computed(
  () =>
    pricing.value.errors.unitPriceCents ??
    (attempted.value ? belowMinimumError.value : null),
)

async function focusSearch() {
  await nextTick()
  searchInput.value?.focus()
}

function showDialog() {
  const el = dialog.value
  if (!el || el.open) return
  // jsdom lacks showModal; the open attribute is enough there.
  if (typeof el.showModal === 'function') {
    el.showModal()
    return
  }
  el.setAttribute('open', '')
}

function hideDialog() {
  const el = dialog.value
  if (!el?.open) return
  if (typeof el.close === 'function') {
    el.close()
    return
  }
  el.removeAttribute('open')
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      hideDialog()
      return
    }
    step.value = 1
    chosen.value = null
    search.query.value = ''
    await nextTick()
    showDialog()
    focusSearch()
    search.clear()
  },
)

async function choose(product: ProductDto) {
  if (unavailableReason(product)) return
  chosen.value = product
  quantityInput.value = '1'
  priceInput.value = ''
  marginInput.value = ''
  source.value = 'price'
  attempted.value = false
  step.value = 2
  await nextTick()
  quantityInputEl.value?.focus()
}

function back() {
  step.value = 1
  focusSearch()
}

function onPrice(value: string) {
  priceInput.value = value
  source.value = 'price'
  if (!chosen.value) return
  marginInput.value =
    marginInputFromPrice(chosen.value.cogsCents, value) ?? marginInput.value
}

function onMargin(value: string) {
  marginInput.value = value
  source.value = 'margin'
  if (!chosen.value) return
  priceInput.value =
    priceInputFromMargin(chosen.value.cogsCents, value) ?? priceInput.value
}

function addToOrder() {
  attempted.value = true
  const product = chosen.value
  // A blank price is allowed (the line stays incomplete); below the minimum is not.
  if (!product || !pricing.value.saveable || belowMinimumError.value) return
  emit('add', {
    product: { ...product },
    quantityInput: quantityInput.value,
    priceInput: priceInput.value,
    marginInput: marginInput.value,
    source: source.value,
  })
}

function inputValue(event: Event) {
  return (event.target as HTMLInputElement).value
}

/** Escape fires `cancel` on a native modal dialog; let the parent close it. */
function onCancel(event: Event) {
  event.preventDefault()
  emit('close')
}
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    aria-labelledby="add-product-heading"
    @cancel="onCancel"
    @keydown.esc.prevent="emit('close')"
  >
    <template v-if="step === 1">
      <h2 id="add-product-heading">Add product: choose a product</h2>
      <p class="search">
        <label for="add-product-search">Search products</label><br />
        <input
          id="add-product-search"
          ref="searchInput"
          type="search"
          placeholder="Name or SKU"
          :value="search.query.value"
          @input="search.setQuery(inputValue($event))"
        />
      </p>
      <ErrorBanner
        v-if="search.error.value"
        :message="search.error.value"
        retryable
        @retry="search.load"
      />
      <p v-else-if="search.loading.value && !search.page.value">Loading…</p>
      <template v-else-if="search.page.value">
        <p v-if="search.items.value.length === 0" role="status">
          <template v-if="search.activeQuery.value"
            >No products match "{{ search.activeQuery.value }}".</template
          >
          <template v-else>No products.</template>
        </p>
        <table v-else aria-label="Products">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">SKU</th>
              <th scope="col">Wholesale cost</th>
              <th scope="col">In stock</th>
              <th scope="col"><span class="visually-hidden">Status</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="product in search.items.value"
              :key="product.id"
              :class="{ 'row-link': !unavailableReason(product) }"
              :tabindex="unavailableReason(product) ? undefined : 0"
              :aria-disabled="unavailableReason(product) ? 'true' : undefined"
              :data-testid="`product-row-${product.id}`"
              @click="choose(product)"
              @keydown.enter.prevent="choose(product)"
            >
              <td>{{ product.name }}</td>
              <td>
                <code>{{ product.sku }}</code>
              </td>
              <td><MoneyText :cents="product.cogsCents" /></td>
              <td class="num">{{ product.stockQuantity }}</td>
              <td class="small">{{ unavailableReason(product) }}</td>
            </tr>
          </tbody>
        </table>
        <PaginationControls
          :offset="search.offset.value"
          :count="search.items.value.length"
          :total="search.total.value"
          :can-previous="search.canPrevious.value"
          :can-next="search.canNext.value"
          label="products"
          @previous="search.previous"
          @next="search.next"
        />
      </template>
      <p class="actions">
        <button type="button" @click="emit('close')">Cancel</button>
      </p>
    </template>

    <form v-else-if="chosen" @submit.prevent="addToOrder">
      <h2 id="add-product-heading">Add {{ chosen.name }}</h2>
      <dl class="facts">
        <dt>SKU</dt>
        <dd>
          <code>{{ chosen.sku }}</code>
        </dd>
        <dt>Wholesale cost</dt>
        <dd><MoneyText :cents="chosen.cogsCents" /></dd>
        <dt>In stock</dt>
        <dd>{{ chosen.stockQuantity }}</dd>
        <dt>Minimum price</dt>
        <dd>
          <MoneyText
            v-if="pricing.minPriceCents !== null"
            :cents="pricing.minPriceCents"
          />
        </dd>
      </dl>

      <p>
        <label for="add-product-qty">Qty</label><br />
        <input
          id="add-product-qty"
          ref="quantityInputEl"
          class="qty"
          type="number"
          min="1"
          step="1"
          :max="chosen.stockQuantity"
          :value="quantityInput"
          :aria-invalid="pricing.errors.quantity ? 'true' : undefined"
          aria-describedby="add-product-qty-error"
          @input="quantityInput = inputValue($event)"
        />
        <span
          v-if="pricing.errors.quantity"
          id="add-product-qty-error"
          class="field-error"
          >{{ pricing.errors.quantity }}</span
        >
      </p>
      <p>
        <label for="add-product-margin">Margin %</label><br />
        <input
          id="add-product-margin"
          class="margin"
          type="text"
          inputmode="decimal"
          placeholder="0.00"
          :value="marginInput"
          :aria-invalid="pricing.errors.margin ? 'true' : undefined"
          aria-describedby="add-product-margin-error"
          @input="onMargin(inputValue($event))"
          @blur="marginInput = normalizedMarginInput(marginInput)"
        /><span aria-hidden="true">%</span>
        <span
          v-if="pricing.errors.margin"
          id="add-product-margin-error"
          class="field-error"
          >{{ pricing.errors.margin }}</span
        >
      </p>
      <p>
        <label for="add-product-price">Patient price (each)</label><br />
        <span aria-hidden="true">$</span>
        <input
          id="add-product-price"
          class="price"
          type="text"
          inputmode="decimal"
          placeholder="0.00"
          :value="priceInput"
          :aria-invalid="
            pricing.errors.unitPriceCents || pricing.belowMinimum
              ? 'true'
              : undefined
          "
          aria-describedby="add-product-min add-product-price-error"
          @input="onPrice(inputValue($event))"
          @blur="priceInput = normalizedPriceInput(priceInput)"
        />
        <span
          v-if="pricing.minPriceCents !== null"
          id="add-product-min"
          class="hint"
          :class="{ negative: pricing.belowMinimum }"
        >
          Min {{ formatCents(pricing.minPriceCents) }}</span
        >
      </p>
      <p aria-live="polite">
        <span
          v-if="priceError"
          id="add-product-price-error"
          class="field-error"
        >
          {{ priceError }}
        </span>
      </p>
      <p>
        Line total:
        <MoneyText
          v-if="pricing.lineTotalCents !== null"
          :cents="pricing.lineTotalCents"
        />
        <span v-else>—</span>
      </p>
      <p class="actions">
        <button type="button" @click="back">Back</button>
        <button type="submit" class="primary">Add to order</button>
        <button type="button" @click="emit('close')">Cancel</button>
      </p>
    </form>
  </dialog>
</template>
