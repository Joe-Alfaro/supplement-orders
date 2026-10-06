<script setup lang="ts">
import type { OrderStatus } from '@supplement-orders/domain'
import Tag from 'primevue/tag'

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

const SEVERITIES: Record<OrderStatus, string> = {
  draft: 'secondary',
  pending_payment: 'warn',
  paid: 'success',
  cancelled: 'danger',
}
</script>

<template>
  <Tag :value="LABELS[status]" :severity="SEVERITIES[status]" />
</template>
