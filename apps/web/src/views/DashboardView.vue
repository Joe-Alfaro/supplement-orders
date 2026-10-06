<script setup lang="ts">
import type {
  AwaitingPaymentOrderDto,
  DashboardPaidOrderDto,
} from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getDashboard, listAwaitingPayment, searchProducts } from '../api'
import { ErrorBanner, MoneyText, PageSummary, StatTile } from '../components'
import { daysWaiting, formatDate, formatDateOfBirth } from '../format'
import { usePagedSearch } from '../search'
import { useResource } from '../useResource'

const router = useRouter()
// Not searchable: the query's q is ignored, only offset and limit are sent.
const awaiting = usePagedSearch(({ offset, limit }) =>
  listAwaitingPayment({ offset, limit }),
)
const sales = useResource(getDashboard)
// Read-only: stock only changes when orders are paid.
const inventory = usePagedSearch(searchProducts)

onMounted(() => {
  awaiting.load()
  sales.load()
  inventory.load()
})

function openOrder(event: DataTableRowClickEvent<DashboardPaidOrderDto>) {
  router.push(`/orders/${event.data.orderId}`)
}

function openAwaitingOrder(
  event: DataTableRowClickEvent<AwaitingPaymentOrderDto>,
) {
  router.push(`/orders/${event.data.id}`)
}

function onAwaitingPage(event: DataTablePageEvent) {
  awaiting.goTo(event.first)
}

function onInventoryPage(event: DataTablePageEvent) {
  inventory.goTo(event.first)
}
</script>

<template>
  <h1>Dashboard</h1>

  <section aria-labelledby="awaiting-heading">
    <h2 id="awaiting-heading">Awaiting payment</h2>
    <ErrorBanner
      v-if="awaiting.error.value"
      :message="awaiting.error.value"
      retryable
      @retry="awaiting.load"
    />
    <p v-else-if="awaiting.loading.value && !awaiting.page.value">Loading…</p>
    <template v-else-if="awaiting.page.value">
      <p v-if="awaiting.items.value.length === 0">Nothing awaiting payment.</p>
      <DataTable
        v-else
        :value="awaiting.items.value"
        data-key="id"
        lazy
        paginator
        :rows="awaiting.limit"
        :first="awaiting.offset.value"
        :total-records="awaiting.total.value"
        paginator-template="PrevPageLink NextPageLink"
        :loading="awaiting.loading.value"
        selection-mode="single"
        :meta-key-selection="false"
        :table-props="{ 'aria-label': 'Awaiting payment' }"
        @page="onAwaitingPage"
        @row-click="openAwaitingOrder"
      >
        <template #paginatorstart>
          <PageSummary
            :offset="awaiting.offset.value"
            :count="awaiting.items.value.length"
            :total="awaiting.total.value"
          />
        </template>
        <Column header="Sent">
          <template #body="{ data }">{{ formatDate(data.sentAt) }}</template>
        </Column>
        <Column header="Patient">
          <template #body="{ data }"
            >{{ data.patientName }} ·
            {{ formatDateOfBirth(data.patientDateOfBirth) }}</template
          >
        </Column>
        <Column header="Patient total">
          <template #body="{ data }"
            ><MoneyText :cents="data.totalCents"
          /></template>
        </Column>
        <Column header="Days waiting">
          <template #body="{ data }">{{ daysWaiting(data.sentAt) }}</template>
        </Column>
      </DataTable>
    </template>
  </section>

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
      <p v-if="sales.data.value.paidOrders.length === 0">No paid orders yet.</p>
      <DataTable
        v-else
        :value="sales.data.value.paidOrders"
        data-key="orderId"
        selection-mode="single"
        :meta-key-selection="false"
        :table-props="{ 'aria-label': 'Paid orders' }"
        @row-click="openOrder"
      >
        <Column header="Paid">
          <template #body="{ data }">{{ formatDate(data.paidAt) }}</template>
        </Column>
        <Column field="patientName" header="Patient" />
        <Column header="Patient total">
          <template #body="{ data }"
            ><MoneyText :cents="data.totalCents"
          /></template>
        </Column>
        <Column header="Wholesale cost">
          <template #body="{ data }"
            ><MoneyText :cents="data.cogsCents"
          /></template>
        </Column>
        <Column header="Processing fee">
          <template #body="{ data }"
            ><MoneyText :cents="data.platformFeeCents"
          /></template>
        </Column>
        <Column header="Your margin">
          <template #body="{ data }"
            ><MoneyText :cents="data.providerMarginCents"
          /></template>
        </Column>
      </DataTable>
    </template>
  </section>

  <section aria-labelledby="inventory-heading">
    <h2 id="inventory-heading">Inventory</h2>
    <p class="muted">
      Stock decreases automatically when orders are paid. It is not edited by
      hand.
    </p>
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
