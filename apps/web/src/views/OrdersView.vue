<script setup lang="ts">
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  type OrderStatus,
  type ProviderOrderListItemDto,
} from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable'
import MultiSelect from 'primevue/multiselect'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listProviderOrders } from '../api'
import { ErrorBanner, MoneyText, PageSummary, StatusBadge } from '../components'
import { formatDate, formatDateOfBirth } from '../format'
import { accessibleSelectPt } from '../primevue'
import { usePagedSearch } from '../search'

const route = useRoute()
const router = useRouter()

const STATUSES: Record<OrderStatus, { dateHeader: string; empty: string }> = {
  draft: { dateHeader: 'Created', empty: 'No draft orders.' },
  pending_payment: { dateHeader: 'Sent', empty: 'No orders awaiting payment.' },
  paid: { dateHeader: 'Paid', empty: 'No paid orders.' },
  cancelled: { dateHeader: 'Cancelled', empty: 'No cancelled orders.' },
}

/** Canonical order for options, the URL and the API. */
const ORDER: OrderStatus[] = ['draft', 'pending_payment', 'paid', 'cancelled']
const DEFAULT_SELECTION: OrderStatus[] = ['pending_payment']

const statusOptions = ORDER.map((value) => ({
  value,
  label: ORDER_STATUS_LABELS[value],
}))

function canonical(statuses: readonly OrderStatus[]) {
  return ORDER.filter((status) => statuses.includes(status))
}

/**
 * ?status= is a comma list; absent means the default, `all` means no filter
 * (an empty selection). Unknown values are ignored.
 */
function selectionFromUrl(value: unknown): OrderStatus[] {
  if (typeof value !== 'string') return [...DEFAULT_SELECTION]
  if (value === 'all') return []
  const parts = value.split(',')
  const statuses = ORDER_STATUSES.filter((status) => parts.includes(status))
  return statuses.length ? canonical(statuses) : [...DEFAULT_SELECTION]
}

// PrimeVue names the select-all box after its state ("All items unselected")
// and shows no text for it; a visible <label> (the header slot) names it
// instead, so the name is on screen (§9). Each option row also renders its own
// checkbox <input>, which axe flags as unlabelled and nested inside an
// interactive option; the option already exposes aria-selected, so that
// checkbox is decorative: hidden from assistive tech and not focusable.
const multiSelectPt = {
  ...accessibleSelectPt,
  pcHeaderCheckbox: {
    input: { id: 'order-status-all', 'aria-label': undefined },
  },
  overlay: { class: 'status-overlay' },
  pcOptionCheckbox: {
    // The whole checkbox is click-through so the click lands on the option row,
    // which persists; a click on the check icon (removed on uncheck) would read
    // as an outside click and close the list.
    root: { style: { pointerEvents: 'none' } },
    input: { 'aria-hidden': 'true', disabled: true },
  },
}

/** The selected statuses; empty means all statuses. */
const selected = ref<OrderStatus[]>(selectionFromUrl(route.query.status))

const orders = usePagedSearch((listQuery) =>
  listProviderOrders({
    statuses: canonical(selected.value),
    offset: listQuery.offset,
    limit: listQuery.limit,
  }),
)
const { items, page, loading, error, offset, total } = orders

const single = computed(() =>
  selected.value.length === 1 ? selected.value[0] : undefined,
)
const dateHeader = computed(() =>
  single.value ? STATUSES[single.value].dateHeader : 'Date',
)
const emptyMessage = computed(() => {
  if (single.value) return STATUSES[single.value].empty
  if (selected.value.length === 0 || selected.value.length === ORDER.length) {
    return 'No orders yet.'
  }
  return 'No orders with the selected statuses.'
})

onMounted(orders.load)

watch(selected, (statuses) => {
  const status = statuses.length ? canonical(statuses).join(',') : 'all'
  router.replace({ query: { status } })
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
      <MultiSelect
        v-model="selected"
        input-id="order-status"
        aria-labelledby="order-status-label"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        placeholder="All statuses"
        :show-toggle-all="true"
        :max-selected-labels="4"
        append-to="self"
        :pt="multiSelectPt"
      >
        <template #header>
          <label for="order-status-all" class="select-all-label"
            >Select all</label
          >
        </template>
      </MultiSelect>
    </div>
  </div>
  <ErrorBanner v-if="error" :message="error" retryable @retry="orders.load" />
  <p v-else-if="loading && !page">Loading…</p>
  <template v-else-if="page">
    <p v-if="items.length === 0" role="status">{{ emptyMessage }}</p>
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
      <Column :header="dateHeader">
        <template #body="{ data }">
          <span v-if="relevantDate(data)">{{
            formatDate(relevantDate(data) ?? '')
          }}</span>
        </template>
      </Column>
    </DataTable>
  </template>
</template>
