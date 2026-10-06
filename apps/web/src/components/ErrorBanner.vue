<script setup lang="ts">
import Button from 'primevue/button'
import Message from 'primevue/message'

interface Props {
  message: string
  /** Shows a Retry button when set. */
  retryable?: boolean
}

defineProps<Props>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <Message severity="error" class="banner">
    <span>{{ message }}</span>
    <Button
      v-if="retryable"
      label="Retry"
      size="small"
      severity="secondary"
      class="banner-action"
      @click="emit('retry')"
    />
  </Message>
</template>
