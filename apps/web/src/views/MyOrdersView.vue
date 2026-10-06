<script setup lang="ts">
import type { PatientOrderSummaryDto } from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable, { type DataTableRowClickEvent } from 'primevue/datatable'
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { listOrders } from '../api'
import { ErrorBanner, MoneyText, StatusBadge } from '../components'
import { formatDate } from '../format'
import { useResource } from '../useResource'

const {
  data: orders,
  loading,
  error,
  load,
} = useResource(async () => {
  const all = await listOrders()
  return all.filter(
    (order): order is PatientOrderSummaryDto => order.view === 'patient',
  )
})
onMounted(load)

const router = useRouter()

// Several orders can share a date, so the whole row is the link.
function openOrder(event: DataTableRowClickEvent<PatientOrderSummaryDto>) {
  router.push(`/my-orders/${event.data.id}`)
}
</script>

<template>
  <h1>My orders</h1>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="orders">
    <p v-if="orders.length === 0">You have no orders yet.</p>
    <DataTable
      v-else
      :value="orders"
      data-key="id"
      selection-mode="single"
      :meta-key-selection="false"
      aria-label="My orders"
      @row-click="openOrder"
    >
      <Column header="Created">
        <template #body="{ data }">{{ formatDate(data.createdAt) }}</template>
      </Column>
      <Column field="providerName" header="Provider" />
      <Column header="Total">
        <template #body="{ data }"
          ><MoneyText :cents="data.totalCents"
        /></template>
      </Column>
      <Column header="Status">
        <template #body="{ data }"
          ><StatusBadge :status="data.status"
        /></template>
      </Column>
    </DataTable>
  </template>
</template>
