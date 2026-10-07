<script setup lang="ts">
import { ORDER_STATUS_LABELS, type OrderStatus } from '@supplement-orders/domain'
import Tag from 'primevue/tag'

interface Props {
  status: OrderStatus
}

defineProps<Props>()

// Awaiting stock is deliberately not the warn colour of Awaiting payment.
const SEVERITIES: Record<OrderStatus, string> = {
  draft: 'secondary',
  pending_payment: 'warn',
  awaiting_stock: 'info',
  paid: 'success',
  cancelled: 'danger',
}
</script>

<template>
  <Tag :value="ORDER_STATUS_LABELS[status]" :severity="SEVERITIES[status]" />
</template>
