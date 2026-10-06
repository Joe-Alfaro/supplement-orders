<script setup lang="ts">
import type { ProviderOrderDetailDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { ApiRequestError, cancelOrder, getOrder, handleApiError } from '../api'
import {
  ErrorBanner,
  LedgerTable,
  LinesTable,
  SplitSummary,
  StatusBadge,
} from '../components'
import { formatDateOfBirth, formatDateTime } from '../format'
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

const confirm = useConfirm()
const cancelling = ref(false)
// Outlives the re-fetch, so a lost race (409) stays explained after reload.
const actionError = ref<string | null>(null)
const heading = useTemplateRef<HTMLHeadingElement>('heading')

// Paid orders can't be cancelled; refunds are out of scope.
const cancellable = computed(
  () =>
    order.value?.status === 'draft' ||
    order.value?.status === 'pending_payment',
)

function confirmCancel() {
  const current = order.value
  if (!current) return
  confirm.require({
    header: 'Cancel order',
    message: `Cancel order #${current.id} for ${current.patientName}? The patient will no longer be able to pay it.`,
    defaultFocus: 'reject',
    rejectProps: { label: 'Keep order', severity: 'secondary' },
    acceptProps: { label: 'Cancel order', severity: 'danger' },
    accept: () => cancel(current.id),
  })
}

async function cancel(orderId: number) {
  if (cancelling.value) return
  cancelling.value = true
  actionError.value = null
  try {
    order.value = await cancelOrder(orderId)
  } catch (err) {
    // Usually the patient paid first: show why, then show what is true now.
    actionError.value = handleApiError(err)
    await load()
  } finally {
    cancelling.value = false
  }
  // The Cancel button is gone; keep keyboard focus on the page.
  await nextTick()
  heading.value?.focus()
}
</script>

<template>
  <ConfirmDialog />
  <div aria-live="polite">
    <ErrorBanner v-if="actionError" :message="actionError" />
  </div>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="order">
    <h1 ref="heading" tabindex="-1">
      Order #{{ order.id }} <StatusBadge :status="order.status" />
    </h1>
    <dl class="facts">
      <dt>Patient</dt>
      <dd>
        <RouterLink :to="`/patients/${order.patientId}`">{{
          order.patientName
        }}</RouterLink>
      </dd>
      <dt>Date of birth</dt>
      <dd>{{ formatDateOfBirth(order.patientDateOfBirth) }}</dd>
      <dt>Ship to</dt>
      <dd>{{ order.patientAddress }}</dd>
      <dt>Created</dt>
      <dd>{{ formatDateTime(order.createdAt) }}</dd>
      <template v-if="order.paidAt">
        <dt>Paid</dt>
        <dd>{{ formatDateTime(order.paidAt) }}</dd>
      </template>
      <template v-if="order.cancelledAt">
        <dt>Cancelled at</dt>
        <dd>{{ formatDateTime(order.cancelledAt) }}</dd>
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
    <p v-if="cancellable">
      <Button
        label="Cancel order"
        severity="danger"
        outlined
        :loading="cancelling"
        :disabled="cancelling"
        @click="confirmCancel"
      />
    </p>

    <h2>Lines</h2>
    <LinesTable :lines="order.lines" show-costs />

    <h2>Split</h2>
    <SplitSummary v-if="order.split" :split="order.split" />
    <p v-else class="muted">
      This draft is incomplete, so there is no split yet.
    </p>

    <template v-if="order.status === 'paid' && order.payment">
      <h2>Ledger</h2>
      <LedgerTable
        :entries="order.ledger"
        :amount-paid-cents="order.payment.amountCents"
      />
    </template>
  </template>
</template>
