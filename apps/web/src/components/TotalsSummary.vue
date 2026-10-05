<script setup lang="ts">
import MoneyText from './MoneyText.vue'

// Patient-facing totals: the patient pays exactly the subtotal. No wholesale
// cost, platform fee, or margin is ever shown here.
interface Props {
  totalCents: number
}

defineProps<Props>()
</script>

<template>
  <table class="summary" aria-label="Order total">
    <tbody>
      <tr class="summary-total">
        <th scope="row">Total</th>
        <td><MoneyText :cents="totalCents" /></td>
      </tr>
    </tbody>
  </table>
</template>
