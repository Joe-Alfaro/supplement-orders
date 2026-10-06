<script setup lang="ts">
import {
  ORDER_LIST_STATUS_FILTERS,
  type OrderListStatusFilter,
  type ProviderOrderListItemDto,
} from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable'
import Select from 'primevue/select'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listProviderOrders } from '../api'
import { ErrorBanner, MoneyText, PageSummary, StatusBadge } from '../components'
import { formatDate, formatDateOfBirth } from '../format'
import { accessibleSelectPt } from '../primevue'
import { usePagedSearch } from '../search'

const route = useRoute()
const router = useRouter()

const DEFAULT_STATUS: OrderListStatusFilter = 'pending_payment'

const FILTERS: Record<
  OrderListStatusFilter,
  { label: string; dateHeader: string; empty: string }
> = {
  pending_payment: {
    label: 'Awaiting payment',
    dateHeader: 'Sent',
    empty: 'No orders awaiting payment.',
  },
  draft: { label: 'Draft', dateHeader: 'Created', empty: 'No draft orders.' },
  paid: { label: 'Paid', dateHeader: 'Paid', empty: 'No paid orders.' },
  cancelled: {
    label: 'Cancelled',
    dateHeader: 'Cancelled',
    empty: 'No cancelled orders.',
  },
  all: { label: 'All statuses', dateHeader: 'Date', empty: 'No orders yet.' },
}

// Awaiting payment first: it's the default and the list that needs action.
const statusOptions = (
  [
    'pending_payment',
    'draft',
    'paid',
    'cancelled',
    'all',
  ] as OrderListStatusFilter[]
).map((value) => ({ value, label: FILTERS[value].label }))

function statusFromUrl(value: unknown): OrderListStatusFilter {
  return ORDER_LIST_STATUS_FILTERS.find((s) => s === value) ?? DEFAULT_STATUS
}

/** The URL wins; the default only applies when it doesn't name a status. */
const status = ref<OrderListStatusFilter>(statusFromUrl(route.query.status))

const orders = usePagedSearch((listQuery) =>
  listProviderOrders({
    status: status.value,
    offset: listQuery.offset,
    limit: listQuery.limit,
  }),
)
const { items, page, loading, error, offset, total } = orders
const filter = computed(() => FILTERS[status.value])

onMounted(orders.load)

watch(status, (value) => {
  router.replace({ query: { status: value } })
  orders.restart()
})

/** The date that matters for the order's own status. */
function relevantDate(order: ProviderOrderListItemDto) {
  if (order.status === 'paid') return order.paidAt
  if (order.status === 'cancelled') return order.cancelledAt
  if (order.status === 'pending_payment') return order.sentAt
  return order.createdAt
}

function openOrder(event: DataTableRowClickEvent<ProviderOrderListItemDto>) {
  router.push(`/orders/${event.data.id}`)
}

function onPage(event: DataTablePageEvent) {
  orders.goTo(event.first)
}
</script>

<template>
  <h1>Orders</h1>
  <div class="filters">
    <div class="field filter">
      <label id="order-status-label" for="order-status">Status</label>
      <Select
        v-model="status"
        input-id="order-status"
        aria-labelledby="order-status-label"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        append-to="self"
        :pt="accessibleSelectPt"
      />
    </div>
  </div>
  <ErrorBanner v-if="error" :message="error" retryable @retry="orders.load" />
  <p v-else-if="loading && !page">Loading…</p>
  <template v-else-if="page">
    <p v-if="items.length === 0" role="status">{{ filter.empty }}</p>
    <DataTable
      v-else
      :value="items"
      data-key="id"
      lazy
      paginator
      :rows="orders.limit"
      :first="offset"
      :total-records="total"
      paginator-template="PrevPageLink NextPageLink"
      selection-mode="single"
      :meta-key-selection="false"
      :loading="loading"
      :table-props="{ 'aria-label': 'Orders' }"
      @page="onPage"
      @row-click="openOrder"
    >
      <template #paginatorstart>
        <PageSummary :offset="offset" :count="items.length" :total="total" />
      </template>
      <Column header="Order #">
        <template #body="{ data }">#{{ data.id }}</template>
      </Column>
      <Column header="Patient">
        <template #body="{ data }"
          >{{ data.patientName }} ·
          {{ formatDateOfBirth(data.patientDateOfBirth) }}</template
        >
      </Column>
      <Column header="Status">
        <template #body="{ data }"
          ><StatusBadge :status="data.status"
        /></template>
      </Column>
      <Column header="Total">
        <template #body="{ data }">
          <MoneyText v-if="data.totalCents !== null" :cents="data.totalCents" />
        </template>
      </Column>
      <Column :header="filter.dateHeader">
        <template #body="{ data }">
          <span v-if="relevantDate(data)">{{
            formatDate(relevantDate(data) ?? '')
          }}</span>
        </template>
      </Column>
    </DataTable>
  </template>
</template>
