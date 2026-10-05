<script setup lang="ts">
import { computed } from 'vue'
import { formatCents } from '../money'

interface Props {
  cents: number
}

const props = defineProps<Props>()
const negative = computed(() => props.cents < 0)
</script>

<template>
  <span class="money" :class="{ negative }">{{ formatCents(cents) }}</span>
</template>
