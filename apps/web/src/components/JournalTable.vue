<script setup lang="ts">
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import { computed } from 'vue'
import type { JournalPostingDto } from '../api'
import MoneyText from './MoneyText.vue'

interface Props {
  postings: JournalPostingDto[]
  /** The table's accessible name. */
  label?: string
}

const props = withDefaults(defineProps<Props>(), { label: 'Journal' })

const debitsCents = computed(() =>
  props.postings.reduce((sum, p) => sum + (p.debitCents ?? 0), 0),
)
const creditsCents = computed(() =>
  props.postings.reduce((sum, p) => sum + (p.creditCents ?? 0), 0),
)
const balances = computed(() => debitsCents.value === creditsCents.value)
</script>

<template>
  <DataTable :value="postings" :table-props="{ 'aria-label': label }" row-hover>
    <Column header="Account">
      <template #body="{ data }">
        <code>{{ data.accountCode }}</code> {{ data.accountName }}
      </template>
      <template #footer>
        Totals
        <span v-if="balances" class="ok">✓ Debits = Credits</span>
        <span v-else class="negative">✗ Debits ≠ Credits</span>
      </template>
    </Column>
    <Column header="Debit">
      <template #body="{ data }">
        <MoneyText v-if="data.debitCents !== null" :cents="data.debitCents" />
      </template>
      <template #footer><MoneyText :cents="debitsCents" /></template>
    </Column>
    <Column header="Credit">
      <template #body="{ data }">
        <MoneyText v-if="data.creditCents !== null" :cents="data.creditCents" />
      </template>
      <template #footer><MoneyText :cents="creditsCents" /></template>
    </Column>
  </DataTable>
</template>
