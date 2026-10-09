<script setup lang="ts">
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
import Tag from 'primevue/tag'
import { computed, nextTick, ref, watch } from 'vue'
import type { ProductDto } from '@supplement-orders/domain'
import { searchProducts } from '../api'
import {
  centsToInput,
  usePricingForm,
  type LineEdit,
  type LineProduct,
  type NewLine,
} from '../builder'
import { usePagedSearch } from '../search'
import ErrorBanner from './ErrorBanner.vue'
import MoneyText from './MoneyText.vue'
import PageSummary from './PageSummary.vue'
import PricingFields from './PricingFields.vue'

interface Props {
  open: boolean
  /** Products already on the order; shown as "Already added" and disabled. */
  excludedProductIds: number[]
  /** When set, the dialog edits this line: pricing step only, prefilled. */
  editing?: NewLine | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  add: [line: NewLine]
  save: [edit: LineEdit]
}>()

const search = usePagedSearch(searchProducts)

const step = ref<1 | 2>(1)
const chosen = ref<LineProduct | null>(null)
const form = usePricingForm(chosen, { idPrefix: 'add-product' })

function unavailableReason(product: ProductDto) {
  if (props.excludedProductIds.includes(product.id)) return 'Already added'
  return null
}

/** The error wins; otherwise the back-order note describes the field. */
const qtyNoteId = computed(() =>
  form.pricing.stockWarning ? 'add-product-qty-warning' : undefined,
)

const stockNote = computed(() => {
  if (!form.pricing.stockWarning) return null
  return `More than the ${chosen.value?.stockQuantity ?? 0} in stock — the rest will be back-ordered.`
})

const title = computed(() => {
  if (step.value !== 2 || !chosen.value) return 'Add product: choose a product'
  return `${props.editing ? 'Edit' : 'Add'} ${chosen.value.name}`
})

async function focusById(id: string) {
  await nextTick()
  document.getElementById(id)?.focus()
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      startEditing(props.editing)
      return
    }
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

function rowClass(product: ProductDto) {
  return unavailableReason(product) ? 'row-unavailable' : ''
}

async function choose(product: ProductDto) {
  if (unavailableReason(product)) return
  chosen.value = product
  // The provider's default is never below the minimum, so a new line starts
  // complete and sendable as-is. Changing it here never changes the default.
  form.startAtPrice(product, centsToInput(product.defaultUnitPriceCents))
  step.value = 2
  focusById('add-product-qty')
}

/** Edit mode: straight to the pricing step with the line's current values. */
function startEditing(line: NewLine) {
  chosen.value = line.product
  form.load(line)
  step.value = 2
  focusById('add-product-qty')
}

function back() {
  step.value = 1
  focusById('add-product-search')
}

function addToOrder() {
  form.attempted = true
  const product = chosen.value
  // A blank price is allowed (the line stays incomplete); below the minimum is not.
  if (!product || !form.pricing.saveable || form.belowMinimumError) return
  const values = form.values()
  if (props.editing) {
    emit('save', values)
    return
  }
  emit('add', { product: { ...product }, ...values })
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
          :table-props="{ 'aria-label': 'Products' }"
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
              <span class="small" :data-testid="`product-status-${data.id}`">
                <template v-if="unavailableReason(data)">{{
                  unavailableReason(data)
                }}</template>
                <Tag
                  v-else-if="data.stockQuantity === 0"
                  severity="secondary"
                  value="Out of stock"
                />
              </span>
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
            v-if="form.pricing.minPriceCents !== null"
            :cents="form.pricing.minPriceCents"
          />
        </dd>
      </dl>

      <PricingFields
        :form="form"
        id-prefix="add-product"
        :qty-note-id="qtyNoteId"
      />
      <div aria-live="polite" data-testid="add-product-warnings">
        <Message
          v-if="stockNote"
          id="add-product-qty-warning"
          severity="warn"
          size="small"
          >{{ stockNote }}</Message
        >
      </div>
      <p>
        Line total:
        <MoneyText
          v-if="form.pricing.lineTotalCents !== null"
          :cents="form.pricing.lineTotalCents"
        />
        <span v-else>—</span>
      </p>
      <div class="actions">
        <Button
          v-if="!editing"
          label="Back"
          severity="secondary"
          @click="back"
        />
        <Button
          type="submit"
          :label="editing ? 'Save changes' : 'Add to order'"
        />
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
