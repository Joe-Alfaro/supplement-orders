<script setup lang="ts">
import Card from 'primevue/card'
import MoneyText from './MoneyText.vue'

interface Props {
  label: string
  cents: number
}

defineProps<Props>()
</script>

<template>
  <Card class="tile">
    <template #subtitle>{{ label }}</template>
    <template #content>
      <span class="tile-value"><MoneyText :cents="cents" /></span>
    </template>
  </Card>
</template>
