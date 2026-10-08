<script setup lang="ts">
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable, { type DataTablePageEvent } from 'primevue/datatable'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { computed, onMounted, ref } from 'vue'
import {
  getAdminAccounts,
  handleApiError,
  listAdminJournals,
  listUnresolvedPaymentAttempts,
  reconcilePaymentAttempt,
} from '../api'
import type {
  AdminPaymentAttemptDto,
  PaymentAttemptStatus,
  ReconcileOutcome,
} from '@supplement-orders/domain'
import {
  ErrorBanner,
  JournalTable,
  MoneyText,
  PageSummary,
} from '../components'
import { formatAge, formatDateTime } from '../format'
import { formatCents } from '../money'
import { usePagedSearch } from '../search'
import { useSuccessToast } from '../toast'
import { useResource } from '../useResource'

const accounts = useResource(getAdminAccounts)
const journals = usePagedSearch(listAdminJournals)
const attempts = useResource(listUnresolvedPaymentAttempts)
const confirm = useConfirm()
const showSuccess = useSuccessToast()
const reconcilingId = ref<number | null>(null)
const reconcileError = ref<string | null>(null)

const STATUS_LABELS = {
  pending: 'Pending',
  succeeded: 'Succeeded, no payment recorded',
  conflict: 'Conflict',
  declined: 'Declined',
  abandoned: 'Abandoned',
} as const

const OUTCOME_LABELS: Record<ReconcileOutcome, string> = {
  finalized: 'payment recorded',
  unchanged: 'already resolved',
  declined: 'declined, stock released',
  abandoned: 'abandoned, stock released',
}

function askReconcile(attempt: AdminPaymentAttemptDto) {
  confirm.require({
    header: 'Reconcile',
    message: `Ask the payment provider what happened to order #${attempt.orderId}'s ${formatCents(attempt.amountCents)} attempt and settle it?`,
    rejectProps: { label: 'Cancel', severity: 'secondary' },
    acceptProps: { label: 'Reconcile' },
    accept: () => reconcile(attempt),
  })
}

async function reconcile(attempt: AdminPaymentAttemptDto) {
  if (reconcilingId.value !== null) return
  reconcilingId.value = attempt.id
  reconcileError.value = null
  try {
    const result = await reconcilePaymentAttempt(attempt.id)
    showSuccess(
      `Order #${attempt.orderId} reconciled: ${OUTCOME_LABELS[result.outcome]}`,
    )
    await Promise.all([attempts.load(), accounts.load(), journals.load()])
  } catch (err) {
    reconcileError.value = handleApiError(err)
    await attempts.load()
  } finally {
    reconcilingId.value = null
  }
}

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
  attempts.load()
})
</script>

<template>
  <ConfirmDialog />
  <h1>Accounts</h1>

  <section aria-labelledby="attempts-heading">
    <h2 id="attempts-heading">Payments needing attention</h2>
    <div aria-live="polite">
      <ErrorBanner v-if="reconcileError" :message="reconcileError" />
    </div>
    <p v-if="attempts.loading.value && !attempts.data.value">Loading…</p>
    <ErrorBanner
      v-else-if="attempts.error.value"
      :message="attempts.error.value"
      retryable
      @retry="attempts.load"
    />
    <template v-else-if="attempts.data.value">
      <p v-if="attempts.data.value.length === 0" role="status">
        No payments need attention.
      </p>
      <DataTable
        v-else
        :value="attempts.data.value"
        data-key="id"
        :table-props="{ 'aria-label': 'Payments needing attention' }"
      >
        <Column header="Order">
          <template #body="{ data }">Order #{{ data.orderId }}</template>
        </Column>
        <Column field="providerName" header="Provider" />
        <Column header="Amount">
          <template #body="{ data }"
            ><MoneyText :cents="data.amountCents"
          /></template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">{{
            STATUS_LABELS[data.status as PaymentAttemptStatus]
          }}</template>
        </Column>
        <Column header="Age">
          <template #body="{ data }">{{ formatAge(data.ageSeconds) }}</template>
        </Column>
        <Column header="Action">
          <template #body="{ data }">
            <Button
              label="Reconcile"
              size="small"
              severity="secondary"
              :aria-label="`Reconcile order ${data.orderId}`"
              :disabled="reconcilingId !== null"
              :loading="reconcilingId === data.id"
              @click="askReconcile(data)"
            />
          </template>
        </Column>
      </DataTable>
    </template>
  </section>

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
