<script setup lang="ts">
interface Props {
  message: string
  /** Shows a Retry button when set. */
  retryable?: boolean
}

defineProps<Props>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="banner banner-error" role="alert">
    <span>{{ message }}</span>
    <button v-if="retryable" type="button" @click="emit('retry')">Retry</button>
  </div>
</template>
