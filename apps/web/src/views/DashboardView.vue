<script setup lang="ts">
import type {
  DashboardDto,
  DashboardRangePreset,
} from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, { type DataTablePageEvent } from 'primevue/datatable'
import DatePicker from 'primevue/datepicker'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, type LocationQuery } from 'vue-router'
import {
  ApiRequestError,
  getDashboard,
  searchProducts,
  type ProviderProductDto,
} from '../api'
import {
  ErrorBanner,
  MoneyText,
  PageSummary,
  SetDefaultPriceDialog,
  StatTile,
} from '../components'
import {
  DEFAULT_RANGE,
  dateToDay,
  dayToDate,
  rangeFromQuery,
  rangeLabel,
  rangeToQuery,
  sameRange,
  toDashboardParams,
  type RangeParams,
} from '../dashboard'
import { PAGE_SIZE, useListUrl, usePagedSearch } from '../search'
import { useResource } from '../useResource'

const route = useRoute()
// URL writes only while still on this page; leaving cancels pending debounces.
const listUrl = useListUrl()
const dashboardPath = listUrl.listPath

interface InventoryUrlState {
  q: string
  offset: number
}

/** `?q=` and 1-based `?page=`; anything missing or malformed is the default. */
function inventoryFromUrl(query: LocationQuery): InventoryUrlState {
  const q = typeof query.q === 'string' ? query.q : ''
  const page = typeof query.page === 'string' ? Number(query.page) : 1
  const valid = Number.isSafeInteger(page) && page >= 1
  return { q, offset: valid ? (page - 1) * PAGE_SIZE : 0 }
}

/** The URL query for a state, omitting defaults (empty search, page 1). */
function inventoryToUrl({ q, offset }: InventoryUrlState) {
  const page = Math.floor(offset / PAGE_SIZE) + 1
  return {
    ...(q ? { q } : {}),
    ...(page > 1 ? { page: String(page) } : {}),
  }
}

// The range and the inventory share one query string; each write keeps both.
// The range is forwarded to the API as written; the server resolves the days.
const range = ref<RangeParams>(rangeFromQuery(route.query))
// Custom stays selected after the provider picks it, even before any dates.
const customRequested = ref(false)

/** Drops a rejected range from the URL and shows the default. */
function fallBackToDefault() {
  range.value = DEFAULT_RANGE
  customRequested.value = false
  listUrl.replaceQuery(urlQuery(inventoryState()))
}

const sales = useResource(async (): Promise<DashboardDto> => {
  try {
    return await getDashboard(toDashboardParams(range.value))
  } catch (error) {
    const rejected = error instanceof ApiRequestError && error.status === 400
    if (!rejected || sameRange(range.value, DEFAULT_RANGE)) throw error
    fallBackToDefault()
    return getDashboard(toDashboardParams(range.value))
  }
})

function urlQuery(state: InventoryUrlState) {
  return { ...inventoryToUrl(state), ...rangeToQuery(range.value) }
}

// Read-only (FR5 deviation, see the README): admins manage stock, providers only
// see it. A payment attempt reserves an order's quantities before charging, a
// decline gives them back, and a recorded payment keeps them as the sale.
const initial = inventoryFromUrl(route.query)
const inventory = usePagedSearch(searchProducts, {
  initialQuery: initial.q,
  initialOffset: initial.offset,
})

listUrl.onLeave(inventory.cancel)

// The product whose default price is being set; null when the dialog is closed.
const pricing = ref<ProviderProductDto | null>(null)

/** Shows the server's row for a product in place, without refetching the page. */
function showSavedDefault(updated: ProviderProductDto) {
  const page = inventory.page.value
  if (!page) return
  inventory.page.value = {
    ...page,
    items: page.items.map((row) => (row.id === updated.id ? updated : row)),
  }
}

function inventoryState(): InventoryUrlState {
  return { q: inventory.activeQuery.value, offset: inventory.offset.value }
}

function urlMatches(state: InventoryUrlState) {
  const current = inventoryFromUrl(route.query)
  return current.q === state.q && current.offset === state.offset
}

const presets: {
  id: Exclude<DashboardRangePreset, 'custom'>
  label: string
}[] = [
  { id: 'month', label: 'This month' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
]

const selected = computed(() => {
  if (customRequested.value) return 'custom'
  return range.value.range ?? 'month'
})

const label = computed(() => {
  const resolved = sales.data.value?.range
  return resolved ? rangeLabel(resolved) : ''
})

function chooseRange(next: RangeParams) {
  if (sameRange(next, range.value)) return
  range.value = next
  listUrl.pushQuery(urlQuery(inventoryState()))
  sales.load()
}

function choosePreset(id: Exclude<DashboardRangePreset, 'custom'>) {
  customRequested.value = false
  chooseRange(id === 'month' ? DEFAULT_RANGE : { range: id })
}

// The picker holds a draft; it applies once both days are chosen (a calendar
// click or leaving the field), never on every keystroke.
const draft = ref<(Date | null)[] | null>(null)

// Shows the custom days in the URL, or else what the server last resolved.
function pickerValue() {
  const { from, to } =
    range.value.range === 'custom' && range.value.from && range.value.to
      ? range.value
      : (sales.data.value?.range ?? {})
  if (!from || !to) return null
  return [dayToDate(from), dayToDate(to)]
}

function onDraft(value: unknown) {
  draft.value = Array.isArray(value) ? (value as (Date | null)[]) : null
}

function applyDraft() {
  const [start, end] = draft.value ?? []
  if (!start || !end) return
  const [from, to] = start <= end ? [start, end] : [end, start]
  chooseRange({ range: 'custom', from: dateToDay(from), to: dateToDay(to) })
}

/** The URL's range keys differ from how this page would write them. */
function rangeNeedsCleaning(query: LocationQuery) {
  const written = rangeToQuery(rangeFromQuery(query))
  return ['range', 'from', 'to'].some(
    (key) => query[key] !== (written as Record<string, string>)[key],
  )
}

onMounted(() => {
  if (rangeNeedsCleaning(route.query)) {
    listUrl.replaceQuery(urlQuery(inventoryState()))
  }
  sales.load()
  inventory.load()
})

// Typing (debounced) replaces the URL, so Back doesn't step through keystrokes.
watch(inventory.activeQuery, () => {
  const state = inventoryState()
  if (!urlMatches(state)) listUrl.replaceQuery(urlQuery(state))
})

// Back/Forward (or a link) changed the URL: show what it says.
watch(
  () => route.query,
  (query) => {
    if (route.path !== dashboardPath) return
    const urlRange = rangeFromQuery(query)
    if (!sameRange(urlRange, range.value)) {
      range.value = urlRange
      customRequested.value = false
      sales.load()
    }
    if (rangeNeedsCleaning(query)) {
      listUrl.replaceQuery(urlQuery(inventoryState()))
    }
    const { q, offset } = inventoryFromUrl(query)
    const state = inventoryState()
    if (q === state.q && offset === state.offset) return
    inventory.show(q, offset)
  },
)

// Page changes push, so Back returns to the previous page.
function onInventoryPage(event: DataTablePageEvent) {
  inventory.goTo(event.first)
  listUrl.pushQuery(urlQuery(inventoryState()))
}
</script>

<template>
  <h1>Dashboard</h1>

  <section aria-labelledby="sales-heading">
    <h2 id="sales-heading">Sales</h2>
    <div class="range-control" role="group" aria-label="Date range">
      <Button
        v-for="preset in presets"
        :key="preset.id"
        :label="preset.label"
        size="small"
        :severity="selected === preset.id ? undefined : 'secondary'"
        :outlined="selected !== preset.id"
        :aria-pressed="selected === preset.id"
        @click="choosePreset(preset.id)"
      />
      <Button
        label="Custom"
        size="small"
        :severity="selected === 'custom' ? undefined : 'secondary'"
        :outlined="selected !== 'custom'"
        :aria-pressed="selected === 'custom'"
        @click="customRequested = true"
      />
    </div>
    <div v-if="selected === 'custom'" class="range-custom">
      <label for="dashboard-range-dates">Custom date range</label>
      <DatePicker
        input-id="dashboard-range-dates"
        selection-mode="range"
        date-format="yy-mm-dd"
        placeholder="yyyy-mm-dd - yyyy-mm-dd"
        append-to="self"
        hide-on-range-selection
        :model-value="pickerValue()"
        @update:model-value="onDraft"
        @date-select="applyDraft"
        @blur="applyDraft"
      />
    </div>
    <p v-if="sales.loading.value">Loading…</p>
    <ErrorBanner
      v-else-if="sales.error.value"
      :message="sales.error.value"
      retryable
      @retry="sales.load"
    />
    <template v-else-if="sales.data.value">
      <p class="range-label">
        Showing: <strong>{{ label }}</strong>
      </p>
      <div class="tiles">
        <StatTile label="GMV" :cents="sales.data.value.gmvCents" />
        <StatTile
          label="Your margin earned"
          :cents="sales.data.value.providerMarginCents"
        />
        <StatTile
          label="Processing fees"
          :cents="sales.data.value.platformFeeCents"
        />
      </div>
      <div class="tiles">
        <StatTile
          label="Owed to you (all time)"
          :cents="sales.data.value.owedToYouCents"
        />
      </div>
    </template>
    <template v-if="sales.data.value">
      <h3 id="sold-heading">Sold by product</h3>
      <p v-if="sales.data.value.soldByProduct.length === 0" role="status">
        No products sold in this range.
      </p>
      <DataTable
        v-else
        :value="sales.data.value.soldByProduct"
        data-key="productId"
        :table-props="{ 'aria-labelledby': 'sold-heading' }"
      >
        <Column field="productName" header="Product" />
        <Column field="unitsSold" header="Units sold" />
        <Column header="Revenue">
          <template #body="{ data }"
            ><MoneyText :cents="data.revenueCents"
          /></template>
        </Column>
      </DataTable>
    </template>
    <p class="section-links">
      <RouterLink to="/orders?status=paid">See paid orders →</RouterLink>
      <RouterLink to="/orders?status=pending_payment"
        >See orders awaiting payment →</RouterLink
      >
    </p>
  </section>

  <section aria-labelledby="inventory-heading">
    <h2 id="inventory-heading">Inventory</h2>
    <div class="search">
      <label for="inventory-search">Search products</label>
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText
          id="inventory-search"
          type="search"
          placeholder="Name or SKU"
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
        @page="onInventoryPage"
      >
        <template #paginatorstart>
          <PageSummary
            :offset="inventory.offset.value"
            :count="inventory.items.value.length"
            :total="inventory.total.value"
          />
        </template>
        <Column field="name" header="Name" />
        <Column header="SKU">
          <template #body="{ data }">
            <code>{{ data.sku }}</code>
          </template>
        </Column>
        <Column header="Wholesale cost">
          <template #body="{ data }"
            ><MoneyText :cents="data.cogsCents"
          /></template>
        </Column>
        <Column field="stockQuantity" header="Stock on hand" />
        <Column header="Default price">
          <template #body="{ data }"
            ><MoneyText :cents="data.defaultUnitPriceCents"
          /></template>
        </Column>
        <Column header="Actions">
          <template #body="{ data }">
            <Button
              label="Set default price"
              :aria-label="`Set default price for ${data.name}`"
              size="small"
              severity="secondary"
              outlined
              @click="pricing = data"
            />
          </template>
        </Column>
      </DataTable>
    </template>
  </section>

  <SetDefaultPriceDialog
    :product="pricing"
    @close="pricing = null"
    @saved="showSavedDefault"
  />
</template>
