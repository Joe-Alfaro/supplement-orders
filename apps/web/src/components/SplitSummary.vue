<script setup lang="ts">
import type { OrderSplitDto } from '@supplement-orders/domain'
import { PLATFORM_FEE_BPS } from '../money'
import MoneyText from './MoneyText.vue'

interface Props {
  split: OrderSplitDto
}

defineProps<Props>()

// 75 bps -> "0.75%"
const feePercent = `${PLATFORM_FEE_BPS / 100}%`
</script>

<template>
  <table class="summary" aria-label="Split summary">
    <tbody>
      <tr>
        <th scope="row">Subtotal</th>
        <td><MoneyText :cents="split.subtotalCents" /></td>
      </tr>
      <tr>
        <th scope="row">Platform fee ({{ feePercent }})</th>
        <td><MoneyText :cents="split.platformFeeCents" /></td>
      </tr>
      <tr class="summary-total">
        <th scope="row">Patient pays</th>
        <td><MoneyText :cents="split.totalCents" /></td>
      </tr>
      <tr class="summary-divider">
        <th scope="row">Wholesale cost</th>
        <td><MoneyText :cents="split.cogsCents" /></td>
      </tr>
      <tr>
        <th scope="row">Your margin</th>
        <td><MoneyText :cents="split.providerMarginCents" /></td>
      </tr>
      <tr>
        <th scope="row">Platform fee</th>
        <td><MoneyText :cents="split.platformFeeCents" /></td>
      </tr>
    </tbody>
  </table>
</template>
