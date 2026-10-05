<script setup lang="ts">
import type { ProviderOrderDetailDto } from '@supplement-orders/domain'
import { onMounted } from 'vue'
import { ApiRequestError, getOrder } from '../api'
import {
  ErrorBanner,
  LedgerTable,
  LinesTable,
  SplitSummary,
  StatusBadge,
} from '../components'
import { formatDateTime } from '../format'
import { useResource } from '../useResource'

interface Props {
  orderId: string
}

const props = defineProps<Props>()

const {
  data: order,
  loading,
  error,
  load,
} = useResource(async (): Promise<ProviderOrderDetailDto> => {
  const detail = await getOrder(Number(props.orderId))
  if (detail.view !== 'provider') {
    throw new ApiRequestError(403, 'FORBIDDEN', 'This is not your order')
  }
  return detail
})
onMounted(load)
</script>

<template>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="order">
    <h1>Order #{{ order.id }} <StatusBadge :status="order.status" /></h1>
    <dl class="facts">
      <dt>Patient</dt>
      <dd>
        <RouterLink :to="`/patients/${order.patientId}`">{{
          order.patientName
        }}</RouterLink>
      </dd>
      <dt>Ship to</dt>
      <dd>{{ order.patientAddress }}</dd>
      <dt>Created</dt>
      <dd>{{ formatDateTime(order.createdAt) }}</dd>
      <template v-if="order.paidAt">
        <dt>Paid</dt>
        <dd>{{ formatDateTime(order.paidAt) }}</dd>
      </template>
      <template v-if="order.payment">
        <dt>Payment reference</dt>
        <dd>
          <code>{{ order.payment.reference }}</code>
        </dd>
      </template>
    </dl>

    <p v-if="order.status === 'draft'">
      <RouterLink
        :to="`/patients/${order.patientId}/orders/new?orderId=${order.id}`"
        >Edit draft</RouterLink
      >
    </p>
    <p v-if="order.status === 'pending_payment'" class="banner" role="status">
      Waiting for patient payment.
    </p>

    <h2>Lines</h2>
    <LinesTable :lines="order.lines" show-costs />

    <h2>Split</h2>
    <SplitSummary :split="order.split" />

    <template v-if="order.status === 'paid' && order.payment">
      <h2>Ledger</h2>
      <LedgerTable
        :entries="order.ledger"
        :amount-paid-cents="order.payment.amountCents"
      />
    </template>
  </template>
</template>
