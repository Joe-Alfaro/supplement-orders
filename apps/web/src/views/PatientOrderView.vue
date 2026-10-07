<script setup lang="ts">
import {
  expectedPayableLinesOf,
  type PatientOrderDetailDto,
} from '@supplement-orders/domain'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { computed, onMounted, ref, watch } from 'vue'
import { ApiRequestError, handleApiError, getOrder, payOrder } from '../api'
import {
  BackorderLinks,
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
// A link from an order to its back-order only changes the route param.
watch(() => props.orderId, load)

/** The server's quote for the in-stock part (14.5); the UI renders it, never recomputes it. */
const quote = computed(() => order.value?.partialPaymentQuote ?? null)
const limited = computed(
  () =>
    order.value?.status === 'pending_payment' &&
    quote.value !== null &&
    quote.value.payable &&
    quote.value.hasShortfall,
)
const payableNow = computed(() => order.value?.status === 'pending_payment')

const paying = ref(false)
const payError = ref<string | null>(null)

interface ChangedNotice {
  message: string
  previousTotalCents: number
  /** Stock moved: the amounts changed, not the prices. */
  stock: boolean
}

const STOCK_CHANGED = 'Stock changed; please review the updated amounts.'
const STOCK_CODES = ['INSUFFICIENT_STOCK', 'AWAITING_STOCK']

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

const payLabel = computed(() => {
  const cents = limited.value
    ? (quote.value?.pay.totalCents ?? 0)
    : (order.value?.totalCents ?? 0)
  const suffix = limited.value ? ' for in-stock items' : ''
  if (paying.value) return `Paying ${formatCents(cents)}${suffix}…`
  return `Pay ${formatCents(cents)}${suffix}`
})

async function pay() {
  const shown = order.value
  if (!shown || paying.value) return
  paying.value = true
  payError.value = null
  changed.value = null
  try {
    // Pay exactly the quote on screen (revision 9); nothing is charged if it changed.
    const partial = limited.value
    order.value = await payOrder(shown.id, {
      ...(partial
        ? {
            mode: 'available' as const,
            expectedPayableLines: expectedPayableLinesOf(shown.lines),
          }
        : {}),
      expectedRevision: shown.revision,
      expectedTotalCents: partial
        ? (quote.value?.pay.totalCents ?? 0)
        : shown.totalCents,
    })
  } catch (err) {
    if (err instanceof ApiRequestError && STOCK_CODES.includes(err.code)) {
      changed.value = {
        message: STOCK_CHANGED,
        previousTotalCents: shown.totalCents,
        stock: true,
      }
      await reloadChangedOrder(shown.id)
      return
    }
    if (err instanceof ApiRequestError && err.code === 'ORDER_CHANGED') {
      const stock = limited.value
      changed.value = {
        message: stock ? STOCK_CHANGED : err.message || CHANGED_FALLBACK,
        previousTotalCents: shown.totalCents,
        stock,
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

    <BackorderLinks
      :split-from-order-id="order.splitFromOrderId"
      :backorder-order-id="order.backorderOrderId"
      base-path="/my-orders"
    />

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
    <Message
      v-if="limited"
      severity="warn"
      class="banner"
      role="status"
      aria-live="polite"
    >
      Some items have limited stock.
    </Message>
    <Message
      v-if="order.status === 'awaiting_stock'"
      severity="info"
      class="banner"
      role="status"
      aria-live="polite"
    >
      These items are out of stock. You'll be able to pay once they're back in
      stock.
    </Message>
    <LinesTable
      :lines="order.lines"
      :show-availability="limited || order.status === 'awaiting_stock'"
    />
    <TotalsSummary :total-cents="order.totalCents" />
    <template v-if="limited">
      <p>
        Pay now (in stock):
        <strong>{{ formatCents(quote?.pay.totalCents ?? 0) }}</strong>
      </p>
      <p>
        Back-order (pay later):
        <strong>{{ formatCents(quote?.backorder.totalCents ?? 0) }}</strong>
      </p>
    </template>

    <div aria-live="polite">
      <Message v-if="changed" severity="warn" class="banner">
        {{ changed.message }}
        <template v-if="order.status === 'pending_payment' && !changed.stock">
          The total was {{ formatCents(changed.previousTotalCents) }} and is now
          <strong>{{ formatCents(order.totalCents) }}</strong
          >.
        </template>
      </Message>
    </div>

    <section v-if="payableNow" aria-label="Payment">
      <p>
        <Button
          :label="payLabel"
          :loading="paying"
          :disabled="paying"
          :aria-busy="paying"
          @click="pay"
        />
      </p>
      <p v-if="limited">
        The remaining items will be saved as a separate order you can pay when
        they're back in stock.
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
      <p v-if="order.backorderOrderId">
        Remaining items moved to order
        <RouterLink :to="`/my-orders/${order.backorderOrderId}`"
          >#{{ order.backorderOrderId }}</RouterLink
        >
      </p>
    </section>
  </template>
</template>
