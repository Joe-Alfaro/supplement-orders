<script setup lang="ts">
import Tag from 'primevue/tag'
import { UI_STATUS_LABELS, type UiOrderStatus } from '../stock'

interface Props {
  status: UiOrderStatus
}

defineProps<Props>()

// Awaiting stock is deliberately not the warn colour of Awaiting payment.
const SEVERITIES: Record<UiOrderStatus, string> = {
  draft: 'secondary',
  pending_payment: 'warn',
  awaiting_stock: 'info',
  paid: 'success',
  cancelled: 'danger',
}
</script>

<template>
  <Tag :value="UI_STATUS_LABELS[status]" :severity="SEVERITIES[status]" />
</template>
