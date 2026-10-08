<script setup lang="ts">
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, { type DataTablePageEvent } from 'primevue/datatable'
import { computed, onMounted, ref } from 'vue'
import { getAdminAccounts, listAdminJournals } from '../api'
import {
  ErrorBanner,
  JournalTable,
  MoneyText,
  PageSummary,
} from '../components'
import { formatDateTime } from '../format'
import { usePagedSearch } from '../search'
import { useResource } from '../useResource'

const accounts = useResource(getAdminAccounts)
const journals = usePagedSearch(listAdminJournals)

const balanced = computed(() => {
  const totals = accounts.data.value?.totals
  return totals !== undefined && totals.debitsCents === totals.creditsCents
})

// DataTable tracks expanded rows as an object keyed by row id.
const expanded = ref<Record<string, boolean>>({})

function isExpanded(id: number) {
  return expanded.value[id] === true
}

function toggle(id: number) {
  const { [id]: was, ...rest } = expanded.value
  expanded.value = was ? rest : { ...rest, [id]: true }
}

function onPage(event: DataTablePageEvent) {
  journals.goTo(event.first)
}

onMounted(() => {
  accounts.load()
  journals.load()
})
</script>

<template>
  <h1>Accounts</h1>

  <section aria-labelledby="trial-balance-heading">
    <h2 id="trial-balance-heading">Trial balance</h2>
    <p v-if="accounts.loading.value">Loading…</p>
    <ErrorBanner
      v-else-if="accounts.error.value"
      :message="accounts.error.value"
      retryable
      @retry="accounts.load"
    />
    <template v-else-if="accounts.data.value">
      <p v-if="accounts.data.value.accounts.length === 0" role="status">
        No accounts.
      </p>
      <DataTable
        v-else
        :value="accounts.data.value.accounts"
        data-key="id"
        :table-props="{ 'aria-label': 'Trial balance' }"
      >
        <Column header="Code">
          <template #body="{ data }"
            ><code>{{ data.code }}</code></template
          >
          <template #footer>Totals</template>
        </Column>
        <Column field="name" header="Account">
          <template #footer>
            <span v-if="balanced" class="ok">✓ Debits = Credits</span>
            <span v-else class="negative">✗ Debits ≠ Credits</span>
          </template>
        </Column>
        <Column field="type" header="Type" />
        <Column header="Debits">
          <template #body="{ data }"
            ><MoneyText :cents="data.debitsCents"
          /></template>
          <template #footer
            ><MoneyText :cents="accounts.data.value.totals.debitsCents"
          /></template>
        </Column>
        <Column header="Credits">
          <template #body="{ data }"
            ><MoneyText :cents="data.creditsCents"
          /></template>
          <template #footer
            ><MoneyText :cents="accounts.data.value.totals.creditsCents"
          /></template>
        </Column>
        <Column header="Balance">
          <template #body="{ data }"
            ><MoneyText :cents="data.balanceCents"
          /></template>
        </Column>
      </DataTable>
    </template>
  </section>

  <section aria-labelledby="journals-heading">
    <h2 id="journals-heading">Journals</h2>
    <ErrorBanner
      v-if="journals.error.value"
      :message="journals.error.value"
      retryable
      @retry="journals.load"
    />
    <p v-else-if="journals.loading.value && !journals.page.value">Loading…</p>
    <template v-else-if="journals.page.value">
      <p v-if="journals.items.value.length === 0" role="status">
        No journals yet.
      </p>
      <DataTable
        v-else
        v-model:expanded-rows="expanded"
        :value="journals.items.value"
        data-key="id"
        lazy
        paginator
        :rows="journals.limit"
        :first="journals.offset.value"
        :total-records="journals.total.value"
        paginator-template="PrevPageLink NextPageLink"
        :loading="journals.loading.value"
        :table-props="{ 'aria-label': 'Journals' }"
        :pt="{
          pcPaginator: {
            paginatorContainer: { 'aria-label': 'Journal pages' },
          },
        }"
        @page="onPage"
      >
        <template #paginatorstart>
          <PageSummary
            :offset="journals.offset.value"
            :count="journals.items.value.length"
            :total="journals.total.value"
          />
        </template>
        <Column header="Postings">
          <template #body="{ data }">
            <Button
              :icon="
                isExpanded(data.id)
                  ? 'pi pi-chevron-down'
                  : 'pi pi-chevron-right'
              "
              text
              size="small"
              severity="secondary"
              :aria-label="`${isExpanded(data.id) ? 'Hide' : 'Show'} postings for journal ${data.id}`"
              :aria-expanded="isExpanded(data.id)"
              @click="toggle(data.id)"
            />
          </template>
        </Column>
        <Column header="Posted">
          <template #body="{ data }">{{
            formatDateTime(data.postedAt)
          }}</template>
        </Column>
        <Column field="memo" header="Memo" />
        <Column header="Order">
          <template #body="{ data }">
            <span v-if="data.orderId !== null">Order #{{ data.orderId }}</span>
            <span v-else>—</span>
          </template>
        </Column>
        <Column header="Provider">
          <template #body="{ data }">{{ data.providerName ?? '—' }}</template>
        </Column>
        <template #expansion="{ data }">
          <JournalTable
            :postings="data.postings"
            :label="`Journal ${data.id} postings`"
          />
        </template>
      </DataTable>
    </template>
  </section>
</template>
