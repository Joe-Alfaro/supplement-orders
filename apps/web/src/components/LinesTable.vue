<script setup lang="ts">
import type { OrderLineDto, ProviderOrderLineDto } from '@supplement-orders/domain'
import MoneyText from './MoneyText.vue'

// Read-only lines. Wholesale cost and margin columns appear only for provider lines with
// `showCosts`; patient lines carry no cost data to show.
interface Props {
  lines: (OrderLineDto | ProviderOrderLineDto)[]
  showCosts?: boolean
}

defineProps<Props>()

function isProviderLine(
  line: OrderLineDto | ProviderOrderLineDto,
): line is ProviderOrderLineDto {
  return 'unitCogsCents' in line
}
</script>

<template>
  <table>
    <thead>
      <tr>
        <th scope="col">Product</th>
        <th v-if="showCosts" scope="col">Wholesale cost</th>
        <th scope="col">Qty</th>
        <th scope="col">Price each</th>
        <th v-if="showCosts" scope="col">Your margin (each)</th>
        <th scope="col">Line total</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="line in lines" :key="line.productId">
        <td>{{ line.productName }}</td>
        <td v-if="showCosts && isProviderLine(line)">
          <MoneyText :cents="line.unitCogsCents" />
        </td>
        <td class="num">{{ line.quantity }}</td>
        <td><MoneyText :cents="line.unitPriceCents" /></td>
        <td v-if="showCosts && isProviderLine(line)">
          <MoneyText :cents="line.unitMarginCents" />
        </td>
        <td><MoneyText :cents="line.lineTotalCents" /></td>
      </tr>
    </tbody>
  </table>
</template>
