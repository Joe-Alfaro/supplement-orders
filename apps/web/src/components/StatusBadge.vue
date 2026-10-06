<script setup lang="ts">
import { ORDER_STATUS_LABELS, type OrderStatus } from '@supplement-orders/domain'
import Tag from 'primevue/tag'

interface Props {
  status: OrderStatus
}

defineProps<Props>()

const SEVERITIES: Record<OrderStatus, string> = {
  draft: 'secondary',
  pending_payment: 'warn',
  paid: 'success',
  cancelled: 'danger',
}
</script>

<template>
  <Tag :value="ORDER_STATUS_LABELS[status]" :severity="SEVERITIES[status]" />
</template>
