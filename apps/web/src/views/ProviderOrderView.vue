<script setup lang="ts">
import type { OrderStatus, ProviderOrderDetailDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import {
  ApiRequestError,
  cancelOrder,
  deleteOrder,
  getOrder,
  handleApiError,
  reopenOrder,
} from '../api'
import {
  ErrorBanner,
  LedgerTable,
  LinesTable,
  SplitSummary,
  StatusBadge,
} from '../components'
import { formatDateOfBirth, formatDateTime } from '../format'
import { showNotice } from '../user'
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

const router = useRouter()
const confirm = useConfirm()
const acting = ref(false)
// Outlives the re-fetch, so a lost race (409) stays explained after reload.
const actionError = ref<string | null>(null)
const heading = useTemplateRef<HTMLHeadingElement>('heading')

interface OrderAction {
  label: string
  prompt: (order: ProviderOrderDetailDto) => string
  keepLabel: string
  destructive: boolean
  run: (order: ProviderOrderDetailDto) => Promise<void>
}

// One action per status (FRONTEND_DESIGN §4.5). Paid orders have none:
// refunds are out of scope.
const ACTIONS: Partial<Record<OrderStatus, OrderAction>> = {
  draft: {
    label: 'Delete draft',
    prompt: (o) =>
      `Delete draft order #${o.id} for ${o.patientName}? This can't be undone.`,
    keepLabel: 'Keep draft',
    destructive: true,
    run: async (o) => {
      await deleteOrder(o.id)
      const patientPath = `/patients/${o.patientId}`
      showNotice('Draft deleted', patientPath)
      await router.push(patientPath)
    },
  },
  pending_payment: {
    label: 'Cancel order',
    prompt: (o) =>
      `Cancel order #${o.id} for ${o.patientName}? The patient will no longer be able to pay it.`,
    keepLabel: 'Keep order',
    destructive: true,
    run: async (o) => {
      order.value = await cancelOrder(o.id)
      // The Cancel button is gone; keep keyboard focus on the page.
      await nextTick()
      heading.value?.focus()
    },
  },
  cancelled: {
    label: 'Reopen as draft',
    prompt: (o) =>
      `Reopen order #${o.id} as a draft? You can edit it and send it again.`,
    keepLabel: 'Keep cancelled',
    destructive: false,
    run: async (o) => {
      await reopenOrder(o.id)
      await router.push(`/patients/${o.patientId}/orders/${o.id}`)
    },
  },
}

const action = computed(() =>
  order.value ? ACTIONS[order.value.status] : undefined,
)

function confirmAction() {
  const current = order.value
  const chosen = action.value
  if (!current || !chosen) return
  confirm.require({
    header: chosen.label,
    message: chosen.prompt(current),
    // Destructive actions start on the safe choice.
    defaultFocus: chosen.destructive ? 'reject' : 'accept',
    rejectProps: { label: chosen.keepLabel, severity: 'secondary' },
    acceptProps: {
      label: chosen.label,
      severity: chosen.destructive ? 'danger' : undefined,
    },
    accept: () => perform(chosen, current),
  })
}

async function perform(chosen: OrderAction, current: ProviderOrderDetailDto) {
  if (acting.value) return
  acting.value = true
  actionError.value = null
  try {
    await chosen.run(current)
  } catch (err) {
    // Usually the order changed elsewhere (e.g. the patient paid first):
    // show why, then show what is true now.
    actionError.value = handleApiError(err)
    await load()
    await nextTick()
    heading.value?.focus()
  } finally {
    acting.value = false
  }
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
      <RouterLink :to="`/patients/${order.patientId}/orders/${order.id}`"
        >Edit draft</RouterLink
      >
    </p>
    <p v-if="order.status === 'pending_payment'" class="banner" role="status">
      Waiting for patient payment.
    </p>
    <p v-if="action">
      <Button
        :label="action.label"
        :severity="action.destructive ? 'danger' : 'secondary'"
        outlined
        :loading="acting"
        :disabled="acting"
        @click="confirmAction"
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
