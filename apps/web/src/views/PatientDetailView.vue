<script setup lang="ts">
import type { ProviderOrderSummaryDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, { type DataTableRowClickEvent } from 'primevue/datatable'
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getPatient, listOrders } from '../api'
import { ErrorBanner, MoneyText, StatusBadge } from '../components'
import { formatDate, formatDateOfBirth } from '../format'
import { useResource } from '../useResource'

interface Props {
  patientId: string
}

const props = defineProps<Props>()
const patientId = computed(() => Number(props.patientId))

const { data, loading, error, load } = useResource(async () => {
  const [patient, orders] = await Promise.all([
    getPatient(patientId.value),
    listOrders({ patientId: patientId.value }),
  ])
  const providerOrders = orders.filter(
    (order): order is ProviderOrderSummaryDto => order.view === 'provider',
  )
  return { patient, orders: providerOrders }
})
onMounted(load)

const router = useRouter()

function openOrder(event: DataTableRowClickEvent<ProviderOrderSummaryDto>) {
  router.push(orderLink(event.data))
}

function orderLink(order: ProviderOrderSummaryDto) {
  if (order.status === 'draft') {
    return `/patients/${order.patientId}/orders/new?orderId=${order.id}`
  }
  return `/orders/${order.id}`
}
</script>

<template>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="data">
    <h1>{{ data.patient.name }}</h1>
    <dl class="facts">
      <dt>Date of birth</dt>
      <dd>{{ formatDateOfBirth(data.patient.dateOfBirth) }}</dd>
      <dt>Shipping address</dt>
      <dd>{{ data.patient.address }}</dd>
    </dl>
    <p>
      <Button
        as="router-link"
        :to="`/patients/${patientId}/orders/new`"
        label="New order"
        icon="pi pi-plus"
      />
    </p>
    <h2>Orders</h2>
    <p v-if="data.orders.length === 0">No orders for this patient yet.</p>
    <DataTable
      v-else
      :value="data.orders"
      data-key="id"
      selection-mode="single"
      :meta-key-selection="false"
      :table-props="{ 'aria-label': 'Orders' }"
      @row-click="openOrder"
    >
      <Column header="Created">
        <template #body="{ data: order }">{{
          formatDate(order.createdAt)
        }}</template>
      </Column>
      <Column header="Status">
        <template #body="{ data: order }"
          ><StatusBadge :status="order.status"
        /></template>
      </Column>
      <Column header="Patient total">
        <template #body="{ data: order }">
          <MoneyText v-if="order.split" :cents="order.split.totalCents" />
          <span v-else class="muted">Incomplete draft</span>
        </template>
      </Column>
      <Column header="Your margin">
        <template #body="{ data: order }">
          <MoneyText
            v-if="order.split"
            :cents="order.split.providerMarginCents"
          />
          <span v-else class="muted">—</span>
        </template>
      </Column>
    </DataTable>
  </template>
</template>
