<script setup lang="ts">
import type { ProviderOrderSummaryDto } from '@supplement-orders/domain'
import { computed, onMounted } from 'vue'
import { getPatient, listOrders } from '../api'
import { ErrorBanner, MoneyText, StatusBadge } from '../components'
import { formatDate } from '../format'
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
    <p>
      <strong>Address:</strong> <span>{{ data.patient.address }}</span>
    </p>
    <p>
      <RouterLink class="button" :to="`/patients/${patientId}/orders/new`"
        >New order</RouterLink
      >
    </p>
    <h2>Orders</h2>
    <p v-if="data.orders.length === 0">No orders for this patient yet.</p>
    <table v-else>
      <thead>
        <tr>
          <th scope="col">Created</th>
          <th scope="col">Status</th>
          <th scope="col">Patient total</th>
          <th scope="col">Your margin</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="order in data.orders" :key="order.id">
          <td>
            <RouterLink :to="orderLink(order)">{{
              formatDate(order.createdAt)
            }}</RouterLink>
          </td>
          <td><StatusBadge :status="order.status" /></td>
          <td><MoneyText :cents="order.split.totalCents" /></td>
          <td><MoneyText :cents="order.split.providerMarginCents" /></td>
        </tr>
      </tbody>
    </table>
  </template>
</template>
