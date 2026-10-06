<script setup lang="ts">
import type { ProductDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { computed, nextTick, ref, watch } from 'vue'
import { searchProducts } from '../api'
import {
  evaluatePricing,
  marginInputFromPrice,
  minimumPriceInput,
  normalizedMarginInput,
  normalizedPriceInput,
  priceInputFromMargin,
  type NewLine,
} from '../builder'
import { formatCents, PLATFORM_FEE_BPS } from '../money'
import { usePagedSearch } from '../search'
import ErrorBanner from './ErrorBanner.vue'
import MoneyText from './MoneyText.vue'
import PageSummary from './PageSummary.vue'

interface Props {
  open: boolean
  /** Products already on the order; shown as "Already added" and disabled. */
  excludedProductIds: number[]
}

const props = defineProps<Props>()
const emit = defineEmits<{ close: []; add: [line: NewLine] }>()

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

const title = computed(() =>
  step.value === 2 && chosen.value
    ? `Add ${chosen.value.name}`
    : 'Add product: choose a product',
)

async function focusById(id: string) {
  await nextTick()
  document.getElementById(id)?.focus()
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    step.value = 1
    chosen.value = null
    search.clear()
  },
)

/**
 * v-model:visible from the Dialog: the X button closes through here. Escape is
 * handled on the dialog root instead of PrimeVue's document listener, so it
 * only ever closes this dialog and behaves the same in tests.
 */
function onVisible(visible: boolean) {
  if (!visible) emit('close')
}

function onRowClick(event: DataTableRowClickEvent<ProductDto>) {
  choose(event.data)
}

function onPage(event: DataTablePageEvent) {
  search.goTo(event.first)
}

const feeLabel = `Processing fee (${PLATFORM_FEE_BPS / 100}%)`

function rowClass(product: ProductDto) {
  return unavailableReason(product) ? 'row-unavailable' : ''
}

async function choose(product: ProductDto) {
  if (unavailableReason(product)) return
  chosen.value = product
  quantityInput.value = '1'
  // Start at the minimum price so a new line is complete and sendable as-is.
  priceInput.value = minimumPriceInput(product.cogsCents)
  marginInput.value =
    marginInputFromPrice(product.cogsCents, priceInput.value) ?? ''
  source.value = 'price'
  attempted.value = false
  step.value = 2
  focusById('add-product-qty')
}

function back() {
  step.value = 1
  focusById('add-product-search')
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
</script>

<template>
  <Dialog
    :visible="open"
    modal
    :header="title"
    :draggable="false"
    :style="{ width: 'min(56rem, 95vw)' }"
    :pt="{ title: { role: 'heading', 'aria-level': 2 } }"
    :close-on-escape="false"
    @update:visible="onVisible"
    @keydown.esc.stop="emit('close')"
  >
    <template v-if="step === 1">
      <div class="search">
        <label for="add-product-search">Search products</label>
        <IconField>
          <InputIcon class="pi pi-search" />
          <InputText
            id="add-product-search"
            type="search"
            placeholder="Name or SKU"
            autofocus
            :model-value="search.query.value"
            @update:model-value="search.setQuery($event ?? '')"
          />
        </IconField>
      </div>
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
        <DataTable
          v-else
          :value="search.items.value"
          data-key="id"
          lazy
          paginator
          :rows="search.limit"
          :first="search.offset.value"
          :total-records="search.total.value"
          paginator-template="PrevPageLink NextPageLink"
          selection-mode="single"
          :meta-key-selection="false"
          :row-class="rowClass"
          :loading="search.loading.value"
          aria-label="Products"
          @page="onPage"
          @row-click="onRowClick"
        >
          <template #paginatorstart>
            <PageSummary
              :offset="search.offset.value"
              :count="search.items.value.length"
              :total="search.total.value"
            />
          </template>
          <Column field="name" header="Name" />
          <Column header="SKU">
            <template #body="{ data }">
              <code>{{ data.sku }}</code>
            </template>
          </Column>
          <Column header="Wholesale cost">
            <template #body="{ data }">
              <MoneyText :cents="data.cogsCents" />
            </template>
          </Column>
          <Column field="stockQuantity" header="In stock" />
          <Column header="Status">
            <template #body="{ data }">
              <span class="small" :data-testid="`product-status-${data.id}`">{{
                unavailableReason(data)
              }}</span>
            </template>
          </Column>
        </DataTable>
      </template>
      <div class="actions">
        <Button label="Cancel" severity="secondary" @click="emit('close')" />
      </div>
    </template>

    <form v-else-if="chosen" @submit.prevent="addToOrder">
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

      <div class="fields">
        <div class="field">
          <label for="add-product-qty">Qty</label>
          <InputText
            id="add-product-qty"
            class="qty"
            inputmode="numeric"
            :model-value="quantityInput"
            :invalid="Boolean(pricing.errors.quantity)"
            :aria-describedby="
              pricing.errors.quantity ? 'add-product-qty-error' : undefined
            "
            @update:model-value="quantityInput = $event ?? ''"
          />
          <Message
            v-if="pricing.errors.quantity"
            id="add-product-qty-error"
            severity="error"
            size="small"
            variant="simple"
            >{{ pricing.errors.quantity }}</Message
          >
        </div>
        <div class="field">
          <label for="add-product-margin">Margin %</label>
          <InputText
            id="add-product-margin"
            class="margin"
            inputmode="decimal"
            placeholder="0.00"
            :model-value="marginInput"
            :invalid="Boolean(pricing.errors.margin)"
            :aria-describedby="
              pricing.errors.margin ? 'add-product-margin-error' : undefined
            "
            @update:model-value="onMargin($event ?? '')"
            @blur="marginInput = normalizedMarginInput(marginInput)"
          />
          <Message
            v-if="pricing.errors.margin"
            id="add-product-margin-error"
            severity="error"
            size="small"
            variant="simple"
            >{{ pricing.errors.margin }}</Message
          >
        </div>
        <div class="field">
          <label for="add-product-fee">{{ feeLabel }}</label>
          <InputText
            id="add-product-fee"
            class="price"
            readonly
            :model-value="
              pricing.lineFeeCents === null
                ? ''
                : formatCents(pricing.lineFeeCents)
            "
          />
        </div>
        <div class="field">
          <label for="add-product-price">Patient price (each)</label>
          <InputText
            id="add-product-price"
            class="price"
            inputmode="decimal"
            placeholder="0.00"
            :model-value="priceInput"
            :invalid="Boolean(priceError) || pricing.belowMinimum"
            aria-describedby="add-product-min add-product-price-error"
            @update:model-value="onPrice($event ?? '')"
            @blur="priceInput = normalizedPriceInput(priceInput)"
          />
          <small
            v-if="pricing.minPriceCents !== null"
            id="add-product-min"
            class="hint"
            :class="{ negative: pricing.belowMinimum }"
          >
            Min {{ formatCents(pricing.minPriceCents) }}</small
          >
        </div>
      </div>
      <div aria-live="polite">
        <Message
          v-if="priceError"
          id="add-product-price-error"
          severity="error"
          size="small"
          variant="simple"
          >{{ priceError }}</Message
        >
      </div>
      <p>
        Line total:
        <MoneyText
          v-if="pricing.lineTotalCents !== null"
          :cents="pricing.lineTotalCents"
        />
        <span v-else>—</span>
      </p>
      <div class="actions">
        <Button label="Back" severity="secondary" @click="back" />
        <Button type="submit" label="Add to order" />
        <Button
          label="Cancel"
          severity="secondary"
          text
          @click="emit('close')"
        />
      </div>
    </form>
  </Dialog>
</template>
