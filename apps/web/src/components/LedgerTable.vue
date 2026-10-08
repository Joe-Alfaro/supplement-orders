<script setup lang="ts">
import { paymentJournalAccountOf, type JournalDto } from '@supplement-orders/domain'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import { computed } from 'vue'
import { formatDateTime } from '../format'
import MoneyText from './MoneyText.vue'

interface Props {
  journal: JournalDto
  amountPaidCents: number
}

const props = defineProps<Props>()

// Revision 16 bridge: the credits of the payment's journal, shown as the
// earlier split rows until the provider Journal table replaces this view.
const CREDIT_LABELS = {
  product_sales: 'Wholesale cost',
  provider_payable: 'Provider margin',
  platform_fee: 'Processing fee',
} as const

interface Entry {
  id: string
  label: string
  amountCents: number
  createdAt: string
}

const entries = computed<Entry[]>(() =>
  props.journal.postings.flatMap((posting) => {
    const account = paymentJournalAccountOf(posting.accountCode)
    if (account === null || account === 'cash' || posting.creditCents === null)
      return []
    return [
      {
        id: posting.accountCode,
        label: CREDIT_LABELS[account],
        amountCents: posting.creditCents,
        createdAt: props.journal.postedAt,
      },
    ]
  }),
)

const totalCents = computed(() =>
  entries.value.reduce((sum, entry) => sum + entry.amountCents, 0),
)
const balances = computed(() => totalCents.value === props.amountPaidCents)
</script>

<template>
  <DataTable
    :value="entries"
    data-key="id"
    :table-props="{ 'aria-label': 'Ledger' }"
  >
    <Column header="Type" footer="Total of entries">
      <template #body="{ data }">{{ data.label }}</template>
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
