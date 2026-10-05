<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  offset: number
  count: number
  total: number
  canPrevious: boolean
  canNext: boolean
  /** Names what is being paged, for the buttons' accessible names. */
  label: string
}

const props = defineProps<Props>()
const emit = defineEmits<{ previous: []; next: [] }>()

const summary = computed(() => {
  if (props.total === 0 || props.count === 0) return null
  const from = props.offset + 1
  const to = props.offset + props.count
  return `Showing ${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')} of ${props.total.toLocaleString('en-US')}`
})
</script>

<template>
  <nav class="pagination" :aria-label="`${label} pages`">
    <span aria-live="polite">{{ summary }}</span>
    <button
      type="button"
      :disabled="!canPrevious"
      :aria-label="`Previous page of ${label}`"
      @click="emit('previous')"
    >
      Previous
    </button>
    <button
      type="button"
      :disabled="!canNext"
      :aria-label="`Next page of ${label}`"
      @click="emit('next')"
    >
      Next
    </button>
  </nav>
</template>
