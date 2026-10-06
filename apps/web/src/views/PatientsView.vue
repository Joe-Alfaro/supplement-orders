<script setup lang="ts">
import type { PatientDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { searchPatients } from '../api'
import { ErrorBanner, PageSummary, StatusBadge } from '../components'
import { formatDateOfBirth } from '../format'
import { usePagedSearch } from '../search'

const route = useRoute()
const router = useRouter()

const initialQuery = typeof route.query.q === 'string' ? route.query.q : ''
const search = usePagedSearch(searchPatients, { initialQuery })
const { query, activeQuery, items, page, loading, error, offset, total } =
  search

onMounted(search.load)

// Keep the search in the URL so it survives reload and back navigation.
watch(activeQuery, (q) => {
  router.replace({ query: q ? { q } : {} })
})

function openPatient(event: DataTableRowClickEvent<PatientDto>) {
  router.push(`/patients/${event.data.id}`)
}

function onPage(event: DataTablePageEvent) {
  search.goTo(event.first)
}
</script>

<template>
  <h1>Patients</h1>
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
  <ErrorBanner v-if="error" :message="error" retryable @retry="search.load" />
  <p v-else-if="loading && !page">Loading…</p>
  <template v-else-if="page">
    <p v-if="items.length === 0" role="status">
      <template v-if="activeQuery">
        No patients match "{{ activeQuery }}".
        <Button
          label="Clear search"
          size="small"
          severity="secondary"
          @click="search.clear"
        />
      </template>
      <template v-else>No patients yet.</template>
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
