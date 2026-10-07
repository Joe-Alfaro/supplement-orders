<script setup lang="ts">
import type { PatientOrderDetailDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import { onMounted, ref } from 'vue'
import { ApiRequestError, handleApiError, getOrder, payOrder } from '../api'
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

interface ChangedNotice {
  message: string
  previousTotalCents: number
}

/** Set when pay was refused because the order changed after it was shown. */
const changed = ref<ChangedNotice | null>(null)

const CHANGED_FALLBACK =
  'This order changed since you opened it. Review the new total before paying.'

/** Show the order as it is now; the patient must click Pay again. */
async function reloadChangedOrder(id: number) {
  try {
    const fresh = await getOrder(id)
    if (fresh.view === 'patient') order.value = fresh
  } catch (err) {
    payError.value = handleApiError(err)
  }
}

async function pay() {
  const shown = order.value
  if (!shown || paying.value) return
  paying.value = true
  payError.value = null
  changed.value = null
  try {
    // Pay exactly the quote on screen (revision 9); nothing is charged if it changed.
    order.value = await payOrder(shown.id, {
      expectedRevision: shown.revision,
      expectedTotalCents: shown.totalCents,
      ...(isDev && simulateFailure.value ? { simulateFailure: true } : {}),
    })
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'ORDER_CHANGED') {
      changed.value = {
        message: err.message || CHANGED_FALLBACK,
        previousTotalCents: shown.totalCents,
      }
      await reloadChangedOrder(shown.id)
      return
    }
    // Nothing was persisted; the order stays payable.
    payError.value = handleApiError(err)
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

    <!-- Informational, not an error: polite status instead of Message's assertive alert. -->
    <Message
      v-if="order.status === 'cancelled'"
      severity="warn"
      class="banner"
      role="status"
      aria-live="polite"
    >
      This order was cancelled by your provider.
    </Message>

    <h2>Items</h2>
    <LinesTable :lines="order.lines" />
    <TotalsSummary :total-cents="order.totalCents" />

    <div aria-live="polite">
      <Message v-if="changed" severity="warn" class="banner">
        {{ changed.message }}
        <template v-if="order.status === 'pending_payment'">
          The total was {{ formatCents(changed.previousTotalCents) }} and is now
          <strong>{{ formatCents(order.totalCents) }}</strong
          >.
        </template>
      </Message>
    </div>

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
