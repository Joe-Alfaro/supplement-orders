<script setup lang="ts">
import type { PatientOrderDetailDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import { onMounted, ref } from 'vue'
import { ApiRequestError, errorMessage, getOrder, payOrder } from '../api'
import {
  ErrorBanner,
  LinesTable,
  StatusBadge,
  TotalsSummary,
} from '../components'
import { formatDateTime } from '../format'
import { formatCents } from '../money'
import { useResource } from '../useResource'

interface Props {
  orderId: string
}

const props = defineProps<Props>()

// The "Simulate gateway failure" toggle exists only in development builds.
const isDev = import.meta.env.DEV

const {
  data: order,
  loading,
  error,
  load,
} = useResource(async (): Promise<PatientOrderDetailDto> => {
  const detail = await getOrder(Number(props.orderId))
  if (detail.view !== 'patient') {
    throw new ApiRequestError(403, 'FORBIDDEN', 'This is not your order')
  }
  return detail
})
onMounted(load)

const paying = ref(false)
const payError = ref<string | null>(null)
const simulateFailure = ref(false)

async function pay() {
  if (!order.value || paying.value) return
  paying.value = true
  payError.value = null
  try {
    order.value = await payOrder(
      order.value.id,
      isDev && simulateFailure.value ? { simulateFailure: true } : {},
    )
  } catch (err) {
    // Nothing was persisted; the order stays payable.
    payError.value = errorMessage(err)
  } finally {
    paying.value = false
  }
}
</script>

<template>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="order">
    <h1>Order #{{ order.id }} <StatusBadge :status="order.status" /></h1>
    <dl class="facts">
      <dt>Provider</dt>
      <dd>{{ order.providerName }}</dd>
      <dt>Ship to</dt>
      <dd>{{ order.patientAddress }}</dd>
    </dl>

    <h2>Items</h2>
    <LinesTable :lines="order.lines" />
    <TotalsSummary :total-cents="order.totalCents" />

    <section v-if="order.status === 'pending_payment'" aria-label="Payment">
      <div v-if="isDev" class="checkbox-field">
        <Checkbox
          v-model="simulateFailure"
          input-id="simulate-failure"
          binary
        />
        <label for="simulate-failure"
          >Simulate gateway failure (dev only)</label
        >
      </div>
      <p>
        <Button
          :label="
            paying
              ? `Paying ${formatCents(order.totalCents)}…`
              : `Pay ${formatCents(order.totalCents)}`
          "
          :loading="paying"
          :disabled="paying"
          :aria-busy="paying"
          @click="pay"
        />
      </p>
      <div aria-live="polite">
        <ErrorBanner v-if="payError" :message="`Payment failed: ${payError}`" />
      </div>
    </section>

    <section v-if="order.status === 'paid'" aria-labelledby="receipt-heading">
      <h2 id="receipt-heading">Receipt</h2>
      <p role="status">
        Paid
        <strong>{{
          formatCents(order.payment?.amountCents ?? order.totalCents)
        }}</strong>
        <template v-if="order.paidAt">
          on {{ formatDateTime(order.paidAt) }}</template
        >.
      </p>
      <p v-if="order.payment">
        Payment reference: <code>{{ order.payment.reference }}</code>
      </p>
    </section>
  </template>
</template>
