<script setup lang="ts">
import type {
  OrderLineDto,
  ProviderOrderLineDto,
} from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import { formatBps } from '../money'
import MoneyText from './MoneyText.vue'

// Read-only lines. Wholesale cost and markup % columns appear only for provider
// lines with `showCosts`; patient lines carry no cost data to show.
interface Props {
  lines: (OrderLineDto | ProviderOrderLineDto)[]
  showCosts?: boolean
  /** Patient view of a pending order: "Only N of Q in stock" per line (revision 14). */
  showAvailability?: boolean
}

defineProps<Props>()
</script>

<template>
  <DataTable :value="lines" :table-props="{ 'aria-label': 'Order lines' }">
    <Column header="Product">
      <template #body="{ data }">{{ data.productName ?? '—' }}</template>
    </Column>
    <Column v-if="showCosts" header="Wholesale cost">
      <template #body="{ data }">
        <MoneyText
          v-if="data.unitCogsCents !== null"
          :cents="data.unitCogsCents"
        />
        <span v-else>—</span>
      </template>
    </Column>
    <Column field="quantity" header="Qty" />
    <Column v-if="showAvailability" header="Availability">
      <template #body="{ data }">
        <span v-if="data.availableQuantity == null">—</span>
        <span v-else-if="data.availableQuantity === 0">Out of stock</span>
        <span v-else-if="data.availableQuantity < data.quantity"
          >Only {{ data.availableQuantity }} of {{ data.quantity }} in
          stock</span
        >
        <span v-else>In stock</span>
      </template>
    </Column>
    <Column header="Price each">
      <template #body="{ data }">
        <MoneyText
          v-if="data.unitPriceCents !== null"
          :cents="data.unitPriceCents"
        />
        <span v-else>—</span>
      </template>
    </Column>
    <Column v-if="showCosts" header="Markup %">
      <template #body="{ data }">
        <span v-if="data.markupBps !== null"
          >{{ formatBps(data.markupBps) }}%</span
        >
        <span v-else>—</span>
      </template>
    </Column>
    <Column header="Line total">
      <template #body="{ data }">
        <MoneyText
          v-if="data.lineTotalCents !== null"
          :cents="data.lineTotalCents"
        />
        <span v-else>—</span>
      </template>
    </Column>
  </DataTable>
</template>
