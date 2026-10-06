<script setup lang="ts">
import type { PatientDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ApiRequestError,
  createOrder,
  handleApiError,
  getOrder,
  getPatient,
  replaceOrderLines,
  sendOrder,
} from '../api'
import { useOrderDraft, type EvaluatedLine, type NewLine } from '../builder'
import {
  AddProductDialog,
  ErrorBanner,
  MoneyText,
  SplitSummary,
} from '../components'
import { formatDateOfBirth } from '../format'
import { formatCents, PLATFORM_FEE_BPS } from '../money'

interface Props {
  patientId: string
  /** Set when reopening an existing draft. */
  orderId?: string
}

const props = defineProps<Props>()
const router = useRouter()

const patientId = computed(() => Number(props.patientId))
const orderId = ref<number | null>(props.orderId ? Number(props.orderId) : null)

const patient = ref<PatientDto | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const saving = ref(false)
const status = ref<string | null>(null)
const banner = ref<string | null>(null)

const draft = useOrderDraft()
const { lines, evaluated, split, canSend } = draft
const feePercent = `${PLATFORM_FEE_BPS / 100}%`

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [loadedPatient, existing] = await Promise.all([
      getPatient(patientId.value),
      orderId.value === null ? null : getOrder(orderId.value),
    ])
    patient.value = loadedPatient
    if (existing) {
      if (existing.status !== 'draft' || existing.view !== 'provider') {
        await router.replace(`/orders/${existing.id}`)
        return
      }
      draft.loadFromServer(existing.lines)
    }
  } catch (err) {
    loadError.value = handleApiError(err)
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** Creates the draft on first save, then replaces its lines. */
async function persist() {
  if (orderId.value === null) {
    const created = await createOrder(patientId.value)
    orderId.value = created.id
    // Keep the URL pointing at the draft so a retry or reload does not create another.
    await router.replace({ query: { orderId: String(created.id) } })
  }
  return replaceOrderLines(orderId.value, draft.toInputs())
}

function handleError(err: unknown) {
  if (
    err instanceof ApiRequestError &&
    draft.applyFieldError(err.field, err.message)
  ) {
    banner.value = 'The server rejected a line. See the highlighted field.'
    return
  }
  banner.value = handleApiError(err)
}

async function run(action: () => Promise<void>) {
  banner.value = null
  status.value = null
  if (!draft.canSave.value) {
    banner.value = 'Fix the highlighted fields first.'
    return
  }
  saving.value = true
  status.value = 'Saving…'
  try {
    await action()
  } catch (err) {
    status.value = null
    handleError(err)
  } finally {
    saving.value = false
  }
}

function saveDraft() {
  return run(async () => {
    const saved = await persist()
    // The server is authoritative: show its saved lines and figures.
    draft.loadFromServer(saved.lines)
    status.value = 'Draft saved.'
  })
}

function sendToPatient() {
  return run(async () => {
    const saved = await persist()
    await sendOrder(saved.id)
    await router.push(`/orders/${saved.id}`)
  })
}

const dialogOpen = ref(false)

function openAddProduct() {
  dialogOpen.value = true
}

/** Closing the modal any way returns focus to Add line. */
async function closeAddProduct() {
  dialogOpen.value = false
  await nextTick()
  document.getElementById('add-line')?.focus()
}

/** The new line appears in the table and its Qty input takes focus. */
async function addFromDialog(line: NewLine) {
  const key = draft.addLine(line)
  dialogOpen.value = false
  await nextTick()
  document.getElementById(fieldId(key, 'qty'))?.focus()
}

function fieldId(key: number, field: string) {
  return `line-${key}-${field}`
}

function rowIndex(row: EvaluatedLine) {
  return evaluated.value.indexOf(row)
}
</script>

<template>
  <p v-if="loading">Loading…</p>
  <ErrorBanner
    v-else-if="loadError"
    :message="loadError"
    retryable
    @retry="load"
  />
  <template v-else>
    <h1>
      {{ orderId === null ? 'New order' : `Draft order #${orderId}` }}
      <template v-if="patient"
        >for {{ patient.name }} · DOB
        {{ formatDateOfBirth(patient.dateOfBirth) }}</template
      >
    </h1>

    <ErrorBanner v-if="banner" :message="banner" />

    <DataTable
      v-if="lines.length > 0"
      :value="evaluated"
      data-key="line.key"
      class="builder"
      :table-props="{ 'aria-label': 'Order lines' }"
    >
      <Column header="Product">
        <template #body="{ data: row }">
          <template v-if="row.product">
            <span :data-testid="`product-${rowIndex(row)}`">{{
              row.product.name
            }}</span>
            <br />
            <span class="small">
              <code>{{ row.product.sku }}</code>
              <template v-if="row.product.stockQuantity !== null">
                · {{ row.product.stockQuantity }} in stock</template
              >
            </span>
          </template>
          <span v-else class="muted">No product (remove this line)</span>
          <Message
            v-if="row.errors.productId"
            :id="fieldId(row.line.key, 'product-error')"
            severity="error"
            size="small"
            variant="simple"
            >{{ row.errors.productId }}</Message
          >
        </template>
      </Column>
      <Column header="Wholesale cost">
        <template #body="{ data: row }">
          <MoneyText v-if="row.product" :cents="row.product.cogsCents" />
          <span v-else>—</span>
        </template>
      </Column>
      <Column header="Qty">
        <template #body="{ data: row }">
          <label :for="fieldId(row.line.key, 'qty')" class="visually-hidden"
            >Quantity for line {{ rowIndex(row) + 1 }}</label
          >
          <InputText
            :id="fieldId(row.line.key, 'qty')"
            class="qty"
            inputmode="numeric"
            :model-value="row.line.quantityInput"
            :invalid="Boolean(row.errors.quantity)"
            :aria-describedby="
              row.errors.quantity
                ? fieldId(row.line.key, 'qty-error')
                : undefined
            "
            @update:model-value="draft.setQuantity(row.line.key, $event ?? '')"
          />
          <Message
            v-if="row.errors.quantity"
            :id="fieldId(row.line.key, 'qty-error')"
            severity="error"
            size="small"
            variant="simple"
            >{{ row.errors.quantity }}</Message
          >
        </template>
      </Column>
      <Column header="Markup %">
        <template #body="{ data: row }">
          <label :for="fieldId(row.line.key, 'markup')" class="visually-hidden"
            >Markup % for line {{ rowIndex(row) + 1 }}</label
          >
          <InputText
            :id="fieldId(row.line.key, 'markup')"
            class="markup"
            inputmode="decimal"
            :placeholder="row.product?.cogsCents === 0 ? '—' : '0.00'"
            :disabled="row.product?.cogsCents === 0"
            :model-value="row.line.markupInput"
            :class="{ negative: row.line.markupInput.startsWith('-') }"
            :invalid="Boolean(row.errors.markup)"
            :aria-describedby="
              row.errors.markup
                ? fieldId(row.line.key, 'markup-error')
                : undefined
            "
            @update:model-value="draft.setMarkup(row.line.key, $event ?? '')"
            @blur="draft.normalizeMarkup(row.line.key)"
          />
          <Message
            v-if="row.errors.markup"
            :id="fieldId(row.line.key, 'markup-error')"
            severity="error"
            size="small"
            variant="simple"
            >{{ row.errors.markup }}</Message
          >
        </template>
      </Column>
      <Column :header="`Processing fee (${feePercent})`">
        <template #body="{ data: row }">
          <span :data-testid="`fee-${rowIndex(row)}`">
            <MoneyText
              v-if="row.lineFeeCents !== null"
              :cents="row.lineFeeCents"
            />
          </span>
        </template>
      </Column>
      <Column header="Patient price (each)">
        <template #body="{ data: row }">
          <label :for="fieldId(row.line.key, 'price')" class="visually-hidden"
            >Patient price for line {{ rowIndex(row) + 1 }}</label
          >
          <InputText
            :id="fieldId(row.line.key, 'price')"
            class="price"
            inputmode="decimal"
            placeholder="0.00"
            :model-value="row.line.priceInput"
            :invalid="Boolean(row.errors.unitPriceCents) || row.belowMinimum"
            :aria-describedby="`${fieldId(row.line.key, 'price-min')} ${fieldId(row.line.key, 'price-error')}`"
            @update:model-value="draft.setPrice(row.line.key, $event ?? '')"
            @blur="draft.normalizePrice(row.line.key)"
          />
          <small
            v-if="row.minPriceCents !== null"
            :id="fieldId(row.line.key, 'price-min')"
            class="hint"
            :class="{ negative: row.belowMinimum }"
            :data-testid="`min-${rowIndex(row)}`"
          >
            Min {{ formatCents(row.minPriceCents) }}
          </small>
          <Message
            v-if="row.errors.unitPriceCents"
            :id="fieldId(row.line.key, 'price-error')"
            severity="error"
            size="small"
            variant="simple"
            >{{ row.errors.unitPriceCents }}</Message
          >
        </template>
      </Column>
      <Column header="Line total">
        <template #body="{ data: row }">
          <MoneyText
            v-if="row.lineTotalCents !== null"
            :cents="row.lineTotalCents"
          />
          <span v-else>—</span>
        </template>
      </Column>
      <Column>
        <template #header><span class="visually-hidden">Remove</span></template>
        <template #body="{ data: row }">
          <Button
            icon="pi pi-trash"
            severity="secondary"
            text
            :aria-label="`Remove line ${rowIndex(row) + 1}`"
            @click="draft.removeLine(row.line.key)"
          />
        </template>
      </Column>
    </DataTable>
    <p v-else>No lines yet. Add a product to start.</p>
    <p>
      <Button
        id="add-line"
        label="Add line"
        icon="pi pi-plus"
        severity="secondary"
        @click="openAddProduct"
      />
    </p>
    <AddProductDialog
      :open="dialogOpen"
      :excluded-product-ids="draft.productIds.value"
      @close="closeAddProduct"
      @add="addFromDialog"
    />

    <h2>Split summary</h2>
    <SplitSummary v-if="split" :split="split" />
    <p v-else class="muted">
      Complete every line (product, quantity, and a price at or above its
      minimum) to see the split. The processing fee is {{ feePercent }} of the
      order and comes out of your margin.
    </p>

    <div class="actions">
      <Button
        label="Save draft"
        severity="secondary"
        :disabled="saving"
        @click="saveDraft"
      />
      <Button
        label="Send to patient"
        :disabled="saving || !canSend"
        @click="sendToPatient"
      />
    </div>
    <p aria-live="polite" class="status">{{ status }}</p>
  </template>
</template>
