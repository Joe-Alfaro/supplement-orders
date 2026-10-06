<script setup lang="ts">
import { computed } from 'vue'

// "Showing 1–25 of 1,240" for a DataTable paginator. PrimeVue's own page report
// prints totals without thousands separators.
interface Props {
  offset: number
  count: number
  total: number
}

const props = defineProps<Props>()

const summary = computed(() => {
  if (props.total === 0 || props.count === 0) return ''
  const format = (n: number) => n.toLocaleString('en-US')
  return `Showing ${format(props.offset + 1)}–${format(props.offset + props.count)} of ${format(props.total)}`
})
</script>

<template>
  <span aria-live="polite">{{ summary }}</span>
</template>
