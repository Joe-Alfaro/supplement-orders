<script setup lang="ts">
import type { LedgerEntryDto } from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import { computed } from 'vue'
import { formatDateTime } from '../format'
import MoneyText from './MoneyText.vue'

interface Props {
  entries: LedgerEntryDto[]
  amountPaidCents: number
}

const props = defineProps<Props>()

const TYPE_LABELS: Record<LedgerEntryDto['type'], string> = {
  cogs: 'Wholesale cost',
  provider_margin: 'Provider margin',
  platform_fee: 'Platform fee',
}

function typeLabel(entry: LedgerEntryDto) {
  return TYPE_LABELS[entry.type]
}

const totalCents = computed(() =>
  props.entries.reduce((sum, entry) => sum + entry.amountCents, 0),
)
const balances = computed(() => totalCents.value === props.amountPaidCents)
</script>

<template>
  <DataTable :value="entries" data-key="id" aria-label="Ledger">
    <Column header="Type" footer="Total of entries">
      <template #body="{ data }">{{ typeLabel(data) }}</template>
    </Column>
    <Column header="Amount">
      <template #body="{ data }"
        ><MoneyText :cents="data.amountCents"
      /></template>
      <template #footer><MoneyText :cents="totalCents" /></template>
    </Column>
    <Column header="Created at">
      <template #body="{ data }">{{ formatDateTime(data.createdAt) }}</template>
      <template #footer>
        <span v-if="balances" class="ok">
          ✓ Equals amount paid (<MoneyText :cents="amountPaidCents" />)
        </span>
        <span v-else class="negative">
          ✗ Does not equal amount paid (<MoneyText :cents="amountPaidCents" />)
        </span>
      </template>
    </Column>
  </DataTable>
</template>
