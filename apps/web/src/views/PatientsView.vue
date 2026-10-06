<script setup lang="ts">
import {
  LATEST_ORDER_STATUS_FILTERS,
  type LatestOrderStatusFilter,
  type PatientDto,
} from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { searchPatients } from '../api'
import { ErrorBanner, PageSummary, StatusBadge } from '../components'
import { formatDateOfBirth } from '../format'
import { accessibleSelectPt } from '../primevue'
import { usePagedSearch } from '../search'

const route = useRoute()
const router = useRouter()

const initialQuery = typeof route.query.q === 'string' ? route.query.q : ''

type StatusChoice = LatestOrderStatusFilter | 'any'

const STATUS_LABELS: Record<StatusChoice, string> = {
  any: 'Any',
  none: 'No orders',
  draft: 'Draft',
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}
const statusOptions = (Object.keys(STATUS_LABELS) as StatusChoice[]).map(
  (value) => ({ value, label: STATUS_LABELS[value] }),
)

function statusFromUrl(value: unknown): StatusChoice {
  return LATEST_ORDER_STATUS_FILTERS.find((s) => s === value) ?? 'any'
}

/** Latest-order-status filter, applied on the server together with search. */
const status = ref<StatusChoice>(statusFromUrl(route.query.status))

const search = usePagedSearch(
  (listQuery) =>
    searchPatients({
      ...listQuery,
      latestStatus: status.value === 'any' ? undefined : status.value,
    }),
  { initialQuery },
)
const { query, activeQuery, items, page, loading, error, offset, total } =
  search

onMounted(search.load)

watch(status, () => search.restart())

// Keep search and filter in the URL so they survive reload and back navigation.
watch([activeQuery, status], ([q, s]) => {
  router.replace({
    query: {
      ...(q ? { q } : {}),
      ...(s === 'any' ? {} : { status: s }),
    },
  })
})

const emptyMessage = computed(() => {
  const filtered =
    status.value === 'any'
      ? ''
      : ` whose latest order is ${STATUS_LABELS[status.value].toLowerCase()}`
  if (status.value === 'none') {
    return activeQuery.value
      ? `No patients without orders match "${activeQuery.value}".`
      : 'Every patient has at least one order.'
  }
  if (activeQuery.value) {
    return `No patients${filtered} match "${activeQuery.value}".`
  }
  return filtered ? `No patients${filtered}.` : 'No patients yet.'
})

function clearFilters() {
  query.value = ''
  status.value = 'any'
  search.clear()
}

function openPatient(event: DataTableRowClickEvent<PatientDto>) {
  router.push(`/patients/${event.data.id}`)
}

function onPage(event: DataTablePageEvent) {
  search.goTo(event.first)
}
</script>

<template>
  <h1>Patients</h1>
  <div class="filters">
    <div class="search">
      <label for="patient-search">Search by name or date of birth</label>
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText
          id="patient-search"
          type="search"
          placeholder="Name, MM/DD/YYYY, or YYYY-MM-DD"
          :model-value="query"
          @update:model-value="search.setQuery($event ?? '')"
        />
      </IconField>
    </div>
    <div class="field filter">
      <label id="latest-status-label" for="latest-status"
        >Latest order status</label
      >
      <Select
        v-model="status"
        input-id="latest-status"
        aria-labelledby="latest-status-label"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        append-to="self"
        :pt="accessibleSelectPt"
      />
    </div>
  </div>
  <ErrorBanner v-if="error" :message="error" retryable @retry="search.load" />
  <p v-else-if="loading && !page">Loading…</p>
  <template v-else-if="page">
    <p v-if="items.length === 0" role="status">
      {{ emptyMessage }}
      <Button
        v-if="activeQuery && status === 'any'"
        label="Clear search"
        size="small"
        severity="secondary"
        @click="search.clear"
      />
      <Button
        v-else-if="activeQuery || status !== 'any'"
        label="Clear filters"
        size="small"
        severity="secondary"
        @click="clearFilters"
      />
    </p>
    <DataTable
      v-else
      :value="items"
      data-key="id"
      lazy
      paginator
      :rows="search.limit"
      :first="offset"
      :total-records="total"
      paginator-template="PrevPageLink NextPageLink"
      selection-mode="single"
      :meta-key-selection="false"
      :loading="loading"
      table-style="min-width: 40rem"
      :table-props="{ 'aria-label': 'Patients' }"
      @page="onPage"
      @row-click="openPatient"
    >
      <template #paginatorstart>
        <PageSummary :offset="offset" :count="items.length" :total="total" />
      </template>
      <Column field="name" header="Name" />
      <Column header="Date of birth">
        <template #body="{ data }">{{
          formatDateOfBirth(data.dateOfBirth)
        }}</template>
      </Column>
      <Column field="orderCount" header="Orders" />
      <Column header="Latest order">
        <template #body="{ data }">
          <StatusBadge
            v-if="data.latestOrderStatus"
            :status="data.latestOrderStatus"
          />
          <span v-else>—</span>
        </template>
      </Column>
    </DataTable>
  </template>
</template>
