<script setup lang="ts">
import type { OrderLineDto, ProviderOrderLineDto } from '@supplement-orders/domain'
import { formatBps } from '../money'
import MoneyText from './MoneyText.vue'

// Read-only lines. Wholesale cost and margin % columns appear only for provider
// lines with `showCosts`; patient lines carry no cost data to show.
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
        <th v-if="showCosts" scope="col">Margin %</th>
        <th scope="col">Line total</th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(line, index) in lines"
        :key="line.productId ?? `line-${index}`"
      >
        <td>{{ line.productName ?? '—' }}</td>
        <td v-if="showCosts && isProviderLine(line)">
          <MoneyText
            v-if="line.unitCogsCents !== null"
            :cents="line.unitCogsCents"
          />
          <span v-else>—</span>
        </td>
        <td class="num">{{ line.quantity }}</td>
        <td>
          <MoneyText
            v-if="line.unitPriceCents !== null"
            :cents="line.unitPriceCents"
          />
          <span v-else>—</span>
        </td>
        <td v-if="showCosts && isProviderLine(line)" class="num">
          <span v-if="line.marginBps !== null">
            {{ formatBps(line.marginBps) }}%
          </span>
          <span v-else>—</span>
        </td>
        <td>
          <MoneyText
            v-if="line.lineTotalCents !== null"
            :cents="line.lineTotalCents"
          />
          <span v-else>—</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>
