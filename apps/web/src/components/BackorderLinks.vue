<script setup lang="ts">
interface Props {
  splitFromOrderId?: number | null
  backorderOrderId?: number | null
  /** Where order pages live for this role: `/orders` or `/my-orders`. */
  basePath: string
}

defineProps<Props>()
</script>

<template>
  <p v-if="splitFromOrderId" class="banner">
    Back-order of order
    <RouterLink :to="`${basePath}/${splitFromOrderId}`"
      >#{{ splitFromOrderId }}</RouterLink
    >
  </p>
  <p v-if="backorderOrderId" class="banner">
    Partially fulfilled: remaining items moved to order
    <RouterLink :to="`${basePath}/${backorderOrderId}`"
      >#{{ backorderOrderId }}</RouterLink
    >
  </p>
</template>
