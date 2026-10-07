<script setup lang="ts">
import Column from 'primevue/column'
import DataTable, { type DataTablePageEvent } from 'primevue/datatable'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import { onMounted, watch } from 'vue'
import { useRoute, type LocationQuery } from 'vue-router'
import { getDashboard, searchProducts } from '../api'
import { ErrorBanner, MoneyText, PageSummary, StatTile } from '../components'
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

const sales = useResource(getDashboard)
// Read-only: shows available stock. A payment attempt reserves an order's
// quantities before charging, a decline gives them back, and a recorded payment
// keeps them as the sale. Nobody edits stock by hand.
const initial = inventoryFromUrl(route.query)
const inventory = usePagedSearch(searchProducts, {
  initialQuery: initial.q,
  initialOffset: initial.offset,
})

listUrl.onLeave(inventory.cancel)

function inventoryState(): InventoryUrlState {
  return { q: inventory.activeQuery.value, offset: inventory.offset.value }
}

function urlMatches(state: InventoryUrlState) {
  const current = inventoryFromUrl(route.query)
  return current.q === state.q && current.offset === state.offset
}

onMounted(() => {
  sales.load()
  inventory.load()
})

// Typing (debounced) replaces the URL, so Back doesn't step through keystrokes.
watch(inventory.activeQuery, () => {
  const state = inventoryState()
  if (!urlMatches(state)) listUrl.replaceQuery(inventoryToUrl(state))
})

// Back/Forward (or a link) changed the URL: show what it says.
watch(
  () => route.query,
  (query) => {
    if (route.path !== dashboardPath) return
    const { q, offset } = inventoryFromUrl(query)
    const state = inventoryState()
    if (q === state.q && offset === state.offset) return
    inventory.show(q, offset)
  },
)

// Page changes push, so Back returns to the previous page.
function onInventoryPage(event: DataTablePageEvent) {
  inventory.goTo(event.first)
  listUrl.pushQuery(inventoryToUrl(inventoryState()))
}
</script>

<template>
  <h1>Dashboard</h1>

  <section aria-labelledby="sales-heading">
    <h2 id="sales-heading">Sales</h2>
    <p v-if="sales.loading.value">Loading…</p>
    <ErrorBanner
      v-else-if="sales.error.value"
      :message="sales.error.value"
      retryable
      @retry="sales.load"
    />
    <template v-else-if="sales.data.value">
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
      </DataTable>
    </template>
  </section>
</template>
