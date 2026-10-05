<script setup lang="ts">
import type { OrderStatus } from '@supplement-orders/domain'

interface Props {
  status: OrderStatus
}

defineProps<Props>()

const LABELS: Record<OrderStatus, string> = {
  draft: 'Draft',
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}
</script>

<template>
  <span class="badge" :class="`badge-${status}`">{{ LABELS[status] }}</span>
</template>
