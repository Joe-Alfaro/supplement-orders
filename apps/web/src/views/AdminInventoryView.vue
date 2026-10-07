<script setup lang="ts">
import { STOCK_QUANTITY_MAX, type AdminProductDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, { type DataTablePageEvent } from 'primevue/datatable'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import { onMounted, reactive, watch } from 'vue'
import { useRoute, type LocationQuery } from 'vue-router'
import {
  ApiRequestError,
  handleApiError,
  incrementProductStock,
  searchAdminProducts,
  setProductStock,
} from '../api'
import { ErrorBanner, MoneyText, PageSummary } from '../components'
import { PAGE_SIZE, useListUrl, usePagedSearch } from '../search'

const route = useRoute()
const listUrl = useListUrl()
const listPath = listUrl.listPath

interface UrlState {
  q: string
  offset: number
}

/** `?q=` and 1-based `?page=`; anything missing or malformed is the default. */
function stateFromUrl(query: LocationQuery): UrlState {
  const q = typeof query.q === 'string' ? query.q : ''
  const page = typeof query.page === 'string' ? Number(query.page) : 1
  const valid = Number.isSafeInteger(page) && page >= 1
  return { q, offset: valid ? (page - 1) * PAGE_SIZE : 0 }
}

/** The URL query for a state, omitting defaults (empty search, page 1). */
function stateToUrl({ q, offset }: UrlState) {
  const page = Math.floor(offset / PAGE_SIZE) + 1
  return {
    ...(q ? { q } : {}),
    ...(page > 1 ? { page: String(page) } : {}),
  }
}

const initial = stateFromUrl(route.query)
const inventory = usePagedSearch(searchAdminProducts, {
  initialQuery: initial.q,
  initialOffset: initial.offset,
})
listUrl.onLeave(inventory.cancel)

function currentState(): UrlState {
  return { q: inventory.activeQuery.value, offset: inventory.offset.value }
}

/** What one row is doing. `saved` is the last stock value the server gave us. */
interface RowState {
  saved: number
  /** What is in the input; null while it is empty. */
  typed: number | null
  pending: boolean
  /** Shown in an alert under the row's controls. */
  message: string | null
}

const rows = reactive<Record<number, RowState>>({})

// A fresh page replaces every row's state, including unsaved edits.
watch(
  () => inventory.page.value,
  (page) => {
    Object.keys(rows).forEach((key) => delete rows[Number(key)])
    page?.items.forEach((item) => {
      rows[item.id] = {
        saved: item.stockQuantity,
        typed: item.stockQuantity,
        pending: false,
        message: null,
      }
    })
  },
)

function rowOf(product: AdminProductDto): RowState {
  return (
    rows[product.id] ?? {
      saved: product.stockQuantity,
      typed: product.stockQuantity,
      pending: false,
      message: null,
    }
  )
}

function isDirty(row: RowState) {
  return row.typed !== row.saved
}

function setTyped(product: AdminProductDto, value: number | null) {
  rowOf(product).typed = value
}

// InputNumber only reports keypresses and paste. Autofill, IME and scripted
// input fire a plain `input` event, so the Save button would never appear.
function onNativeInput(product: AdminProductDto, event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  const digits = event.target.value.replace(/\D/g, '')
  if (digits === '') {
    setTyped(product, null)
    return
  }
  setTyped(product, Math.min(Number(digits), STOCK_QUANTITY_MAX))
}

function applyServerStock(row: RowState, updated: AdminProductDto) {
  row.saved = updated.stockQuantity
  row.typed = updated.stockQuantity
}

async function increment(product: AdminProductDto, by: number) {
  const row = rowOf(product)
  if (row.pending || isDirty(row)) return
  row.pending = true
  row.message = null
  try {
    applyServerStock(row, await incrementProductStock(product.id, by))
  } catch (err) {
    row.message = `Could not add ${by} to ${product.name}: ${handleApiError(err)}`
  } finally {
    row.pending = false
  }
}

async function save(product: AdminProductDto) {
  const row = rowOf(product)
  if (row.pending || !isDirty(row) || row.typed === null) return
  row.pending = true
  row.message = null
  try {
    applyServerStock(
      row,
      await setProductStock(product.id, {
        stockQuantity: row.typed,
        expectedStockQuantity: row.saved,
      }),
    )
  } catch (err) {
    const current =
      err instanceof ApiRequestError && err.code === 'STOCK_CHANGED'
        ? err.currentStockQuantity
        : undefined
    if (current === undefined) {
      row.message = `Could not save ${product.name}: ${handleApiError(err)}`
    } else {
      // Keep what the admin typed; they decide whether it still makes sense.
      row.saved = current
      row.message = `Stock changed to ${current} since you loaded it. Review and save again.`
    }
  } finally {
    row.pending = false
  }
}

function cancel(product: AdminProductDto) {
  const row = rowOf(product)
  row.typed = row.saved
  row.message = null
}

onMounted(() => inventory.load())

// Typing (debounced) replaces the URL, so Back doesn't step through keystrokes.
watch(inventory.activeQuery, () => {
  const state = currentState()
  const url = stateFromUrl(route.query)
  if (url.q !== state.q || url.offset !== state.offset) {
    listUrl.replaceQuery(stateToUrl(state))
  }
})

// Back/Forward (or a link) changed the URL: show what it says.
watch(
  () => route.query,
  (query) => {
    if (route.path !== listPath) return
    const { q, offset } = stateFromUrl(query)
    const state = currentState()
    if (q === state.q && offset === state.offset) return
    inventory.show(q, offset)
  },
)

// Page changes push, so Back returns to the previous page.
function onPage(event: DataTablePageEvent) {
  inventory.goTo(event.first)
  listUrl.pushQuery(stateToUrl(currentState()))
}

const INCREMENTS = [1, 10, 100]
</script>

<template>
  <h1>Inventory</h1>

  <section aria-labelledby="inventory-heading">
    <h2 id="inventory-heading" class="visually-hidden">Products</h2>
    <div class="search">
      <label for="admin-inventory-search">Search products</label>
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText
          id="admin-inventory-search"
          type="search"
          placeholder="Name"
          :model-value="inventory.query.value"
          @update:model-value="inventory.setQuery($event ?? '')"
        />
      </IconField>
    </div>
    <ErrorBanner
      v-if="inventory.error.value"
      :message="inventory.error.value"
      retryable
      @retry="inventory.load"
    />
    <p v-else-if="inventory.loading.value && !inventory.page.value">Loading…</p>
    <template v-else-if="inventory.page.value">
      <p v-if="inventory.items.value.length === 0" role="status">
        <template v-if="inventory.activeQuery.value"
          >No products match "{{ inventory.activeQuery.value }}".</template
        >
        <template v-else>No products.</template>
      </p>
      <DataTable
        v-else
        :value="inventory.items.value"
        data-key="id"
        lazy
        paginator
        :rows="inventory.limit"
        :first="inventory.offset.value"
        :total-records="inventory.total.value"
        paginator-template="PrevPageLink NextPageLink"
        :loading="inventory.loading.value"
        :table-props="{ 'aria-label': 'Inventory' }"
        :pt="{
          pcPaginator: {
            paginatorContainer: { 'aria-label': 'Inventory pages' },
          },
        }"
        @page="onPage"
      >
        <template #paginatorstart>
          <PageSummary
            :offset="inventory.offset.value"
            :count="inventory.items.value.length"
            :total="inventory.total.value"
          />
        </template>
        <Column field="name" header="Product" />
        <Column header="Wholesale cost">
          <template #body="{ data }"
            ><MoneyText :cents="data.wholesaleCostCents"
          /></template>
        </Column>
        <Column header="Stock">
          <template #body="{ data }">
            <div
              class="stock-cell"
              @input="onNativeInput(data, $event)"
              @keydown.enter.prevent="save(data)"
              @keydown.esc="cancel(data)"
            >
              <div class="stock-controls">
                <InputNumber
                  :model-value="rowOf(data).typed"
                  :min="0"
                  :max="STOCK_QUANTITY_MAX"
                  :use-grouping="false"
                  :max-fraction-digits="0"
                  :aria-label="`Stock for ${data.name}`"
                  :disabled="rowOf(data).pending"
                  @input="setTyped(data, $event.value as number | null)"
                  @update:model-value="setTyped(data, $event)"
                />
                <Button
                  v-for="by in INCREMENTS"
                  :key="by"
                  :label="`+${by}`"
                  :aria-label="`Add ${by} to ${data.name}`"
                  size="small"
                  severity="secondary"
                  :disabled="rowOf(data).pending || isDirty(rowOf(data))"
                  @click="increment(data, by)"
                />
                <template v-if="isDirty(rowOf(data))">
                  <Button
                    label="Save"
                    :aria-label="`Save stock for ${data.name}`"
                    size="small"
                    :disabled="
                      rowOf(data).pending || rowOf(data).typed === null
                    "
                    @click="save(data)"
                  />
                  <Button
                    label="Cancel"
                    :aria-label="`Cancel editing ${data.name}`"
                    size="small"
                    severity="secondary"
                    outlined
                    :disabled="rowOf(data).pending"
                    @click="cancel(data)"
                  />
                </template>
              </div>
              <p v-if="rowOf(data).message" role="alert" class="stock-message">
                {{ rowOf(data).message }}
              </p>
            </div>
          </template>
        </Column>
      </DataTable>
    </template>
  </section>
</template>
