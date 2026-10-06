<script setup lang="ts">
import Card from 'primevue/card'
import { useId } from 'vue'
import MoneyText from './MoneyText.vue'

interface Props {
  label: string
  cents: number
}

defineProps<Props>()

// The tile is a named group so its label and amount are read together.
const labelId = useId()
</script>

<template>
  <Card class="tile" role="group" :aria-labelledby="labelId">
    <template #subtitle
      ><span :id="labelId">{{ label }}</span></template
    >
    <template #content>
      <span class="tile-value"><MoneyText :cents="cents" /></span>
    </template>
  </Card>
</template>
