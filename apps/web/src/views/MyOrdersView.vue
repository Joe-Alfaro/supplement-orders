<script setup lang="ts">
import type { PatientOrderSummaryDto } from '@supplement-orders/domain'
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
function openOrder(orderId: number) {
  router.push(`/my-orders/${orderId}`)
}
</script>

<template>
  <h1>My orders</h1>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="orders">
    <p v-if="orders.length === 0">You have no orders yet.</p>
    <table v-else>
      <thead>
        <tr>
          <th scope="col">Created</th>
          <th scope="col">Provider</th>
          <th scope="col">Total</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="order in orders"
          :key="order.id"
          class="row-link"
          tabindex="0"
          @click="openOrder(order.id)"
          @keydown.enter="openOrder(order.id)"
        >
          <td>{{ formatDate(order.createdAt) }}</td>
          <td>{{ order.providerName }}</td>
          <td><MoneyText :cents="order.totals.totalCents" /></td>
          <td><StatusBadge :status="order.status" /></td>
        </tr>
      </tbody>
    </table>
  </template>
</template>
