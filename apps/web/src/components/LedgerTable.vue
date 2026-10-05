<script setup lang="ts">
import type { LedgerEntryDto } from '@supplement-orders/domain'
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

const totalCents = computed(() =>
  props.entries.reduce((sum, entry) => sum + entry.amountCents, 0),
)
const balances = computed(() => totalCents.value === props.amountPaidCents)
</script>

<template>
  <table aria-label="Ledger">
    <thead>
      <tr>
        <th scope="col">Type</th>
        <th scope="col">Amount</th>
        <th scope="col">Created at</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="entry in entries" :key="entry.id">
        <td>{{ TYPE_LABELS[entry.type] }}</td>
        <td><MoneyText :cents="entry.amountCents" /></td>
        <td>{{ formatDateTime(entry.createdAt) }}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <th scope="row">Total of entries</th>
        <td><MoneyText :cents="totalCents" /></td>
        <td v-if="balances" class="ok">
          ✓ Equals amount paid (<MoneyText :cents="amountPaidCents" />)
        </td>
        <td v-else class="negative">
          ✗ Does not equal amount paid (<MoneyText :cents="amountPaidCents" />)
        </td>
      </tr>
    </tfoot>
  </table>
</template>
