<script setup lang="ts">
import type { OrderTotalsDto } from '@supplement-orders/domain'
import MoneyText from './MoneyText.vue'

// Patient-facing totals: never wholesale cost or margin.
interface Props {
  totals: OrderTotalsDto
}

defineProps<Props>()
</script>

<template>
  <table class="summary" aria-label="Order totals">
    <tbody>
      <tr>
        <th scope="row">Subtotal</th>
        <td><MoneyText :cents="totals.subtotalCents" /></td>
      </tr>
      <tr>
        <th scope="row">Platform fee</th>
        <td><MoneyText :cents="totals.platformFeeCents" /></td>
      </tr>
      <tr class="summary-total">
        <th scope="row">Total</th>
        <td><MoneyText :cents="totals.totalCents" /></td>
      </tr>
    </tbody>
  </table>
</template>
