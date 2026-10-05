<script setup lang="ts">
import MoneyText from './MoneyText.vue'

interface Props {
  label: string
  cents: number
}

defineProps<Props>()
</script>

<template>
  <div class="tile">
    <div class="tile-label">{{ label }}</div>
    <div class="tile-value"><MoneyText :cents="cents" /></div>
  </div>
</template>
