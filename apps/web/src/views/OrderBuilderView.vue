<script setup lang="ts">
import type { PatientDto } from '@supplement-orders/domain'
import Button from 'primevue/button'
import Column from 'primevue/column'
import ConfirmDialog from 'primevue/confirmdialog'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  ApiRequestError,
  createOrder,
  deleteOrder,
  handleApiError,
  getOrder,
  getPatient,
  replaceOrderLines,
  sendOrder,
} from '../api'
import {
  normalizedMarkupInput,
  useOrderDraft,
  type EvaluatedLine,
  type LineEdit,
  type NewLine,
} from '../builder'
import {
  AddProductDialog,
  ErrorBanner,
  MoneyText,
  SplitSummary,
} from '../components'
import { formatDateOfBirth } from '../format'
import { formatCents, PLATFORM_FEE_BPS } from '../money'
import { useSuccessToast } from '../toast'

interface Props {
  patientId: string
  /** `new` for an unsaved order, otherwise the id of a saved draft. */
  orderId: string
}

const props = defineProps<Props>()
const router = useRouter()

const patientId = computed(() => Number(props.patientId))

function savedOrderId(param: string) {
  return param === 'new' ? null : Number(param)
}

const orderId = ref<number | null>(savedOrderId(props.orderId))

const patient = ref<PatientDto | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const saving = ref(false)
/** In-flight text only; success confirmations are toasts. */
const status = ref<string | null>(null)
const banner = ref<string | null>(null)

const showSuccess = useSuccessToast()
const draft = useOrderDraft()
const { lines, evaluated, split, canSend, lowStock } = draft
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
      if (existing.patientId !== patientId.value) {
        throw new ApiRequestError(404, 'NOT_FOUND', 'Order not found')
      }
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

// The first save swaps /new for /:orderId, which arrives here as an id this
// page already holds. Anything else is a different draft: start over.
watch(
  () => props.orderId,
  (param) => {
    if (savedOrderId(param) === orderId.value) return
    orderId.value = savedOrderId(param)
    draft.loadFromServer([])
    banner.value = null
    load()
  },
)

/** Creates the draft on first save, then replaces its lines. */
async function persist() {
  if (orderId.value === null) {
    const created = await createOrder(patientId.value)
    orderId.value = created.id
    // Keep the URL pointing at the draft so a retry or reload does not create
    // another. Same route record, so the builder keeps its state.
    await router.replace(`/patients/${patientId.value}/orders/${created.id}`)
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
  if (!draft.canSave.value) {
    banner.value = 'Fix the highlighted fields first.'
    return
  }
  saving.value = true
  status.value = 'Saving…'
  try {
    await action()
  } catch (err) {
    handleError(err)
  } finally {
    status.value = null
    saving.value = false
  }
}

function saveDraft() {
  return run(async () => {
    const saved = await persist()
    // The server is authoritative: show its saved lines and figures.
    draft.loadFromServer(saved.lines)
    showSuccess('Draft saved')
  })
}

interface LowStockLine {
  name: string
  quantity: number
  available: number
}

/** Over-stock lines shown in the confirmation; null while it is closed. */
const lowStockPrompt = ref<LowStockLine[] | null>(null)

/** Over-stock lines need an explicit OK before sending (§4.10). */
function sendToPatient() {
  if (lowStock.value.length === 0) return sendNow(false)
  lowStockPrompt.value = lowStock.value
  return Promise.resolve()
}

function sendAnyway() {
  lowStockPrompt.value = null
  return sendNow(true)
}

function sendNow(acknowledgeLowStock: boolean) {
  return run(async () => {
    const saved = await persist()
    try {
      await sendOrder(
        saved.id,
        acknowledgeLowStock ? { acknowledgeLowStock } : undefined,
      )
    } catch (err) {
      // Stock changed since the page loaded: ask again with the server's lines.
      const serverLines = lowStockLinesFrom(err)
      if (!serverLines) throw err
      lowStockPrompt.value = serverLines
      return
    }
    await router.push(`/orders/${saved.id}`)
  })
}

interface ServerLowStockLine {
  productName: string
  quantity: number
  availableQuantity: number
}

function lowStockLinesFrom(err: unknown): LowStockLine[] | null {
  if (!(err instanceof ApiRequestError)) return null
  if (err.code !== 'LOW_STOCK_UNACKNOWLEDGED') return null
  const lines = err.details?.lines as ServerLowStockLine[] | undefined
  if (!Array.isArray(lines)) return null
  return lines.map((line) => ({
    name: line.productName,
    quantity: line.quantity,
    available: line.availableQuantity,
  }))
}

const confirm = useConfirm()
const deleting = ref(false)

function confirmDelete() {
  const id = orderId.value
  if (id === null || !patient.value) return
  confirm.require({
    header: 'Delete draft',
    message: `Delete draft order #${id} for ${patient.value.name}? This can't be undone.`,
    // Destructive: start on the safe choice.
    defaultFocus: 'reject',
    rejectProps: { label: 'Keep draft', severity: 'secondary' },
    acceptProps: { label: 'Delete draft', severity: 'danger' },
    accept: () => removeDraft(id),
  })
}

async function removeDraft(id: number) {
  if (deleting.value) return
  deleting.value = true
  banner.value = null
  try {
    await deleteOrder(id)
    const patientPath = `/patients/${patientId.value}`
    showSuccess('Draft deleted')
    await router.push(patientPath)
  } catch (err) {
    banner.value = handleApiError(err)
  } finally {
    deleting.value = false
  }
}

const dialogOpen = ref(false)
/** The line being edited, or null when the dialog adds a product. */
const editingLine = ref<NewLine | null>(null)
const editingKey = ref<number | null>(null)

function openAddProduct() {
  editingLine.value = null
  editingKey.value = null
  dialogOpen.value = true
}

function openEditLine(row: EvaluatedLine) {
  const { product, line } = row
  if (!product) return
  editingKey.value = line.key
  editingLine.value = {
    product,
    quantityInput: line.quantityInput,
    priceInput: line.priceInput,
    markupInput: line.markupInput,
    source: line.source,
  }
  dialogOpen.value = true
}

/** Closing the modal any way returns focus to its opener: Add line, or the line's Edit. */
async function closeAddProduct() {
  dialogOpen.value = false
  const key = editingKey.value
  await nextTick()
  document
    .getElementById(key === null ? 'add-line' : fieldId(key, 'edit'))
    ?.focus()
}

/** Edit dialog saved: update the line in place, same draft-save path as any change. */
async function saveFromDialog(edit: LineEdit) {
  const key = editingKey.value
  if (key === null) return
  draft.updateLine(key, edit)
  await closeAddProduct()
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

// In-row inputs are named by visible text only (§9): the column header plus the
// row's product name, e.g. "Qty Magnesium Glycinate 400 mg (90 caps)".
const tableId = useId()

function headerId(column: string) {
  return `${tableId}-${column}-header`
}

function inputLabelledBy(key: number, column: string) {
  return `${headerId(column)} ${fieldId(key, 'name')}`
}

interface TableError {
  id: string
  text: string
}

/** One entry per problem across the lines, in line order; each id is its input's aria-describedby target. */
const tableWarnings = computed<TableError[]>(() =>
  evaluated.value.flatMap((row) =>
    row.stockWarning
      ? [
          {
            id: fieldId(row.line.key, 'qty-warning'),
            text: `Qty (${row.product?.name ?? 'No product'}) - ${row.stockWarning}`,
          },
        ]
      : [],
  ),
)

const tableErrors = computed<TableError[]>(() =>
  evaluated.value.flatMap((row) => {
    const name = row.product?.name ?? 'No product'
    const { quantity, unitPriceCents } = row.errors
    const belowMinimum =
      row.belowMinimum && row.minPriceCents !== null
        ? `Price must be at least ${formatCents(row.minPriceCents)}`
        : null
    const price = unitPriceCents ?? belowMinimum
    return [
      quantity
        ? {
            id: fieldId(row.line.key, 'qty-error'),
            text: `Qty (${name}) - ${quantity}`,
          }
        : null,
      price
        ? {
            id: fieldId(row.line.key, 'price-error'),
            text: `Patient price (${name}) - ${price}`,
          }
        : null,
    ].filter((item): item is TableError => item !== null)
  }),
)

/** Markup follows the price: blank until a price is set, and for a $0 cost. */
function markupText(row: EvaluatedLine) {
  if (row.priceCents === null) return '—'
  return normalizedMarkupInput(row.line.markupInput) || '—'
}

/** The error wins; otherwise a stock warning describes the Qty input. */
function qtyDescribedBy(row: EvaluatedLine) {
  if (row.errors.quantity) return fieldId(row.line.key, 'qty-error')
  if (row.stockWarning) return fieldId(row.line.key, 'qty-warning')
  return undefined
}

function rowIndex(row: EvaluatedLine) {
  return evaluated.value.indexOf(row)
}
</script>

<template>
  <ConfirmDialog />
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
            <span
              :id="fieldId(row.line.key, 'name')"
              :data-testid="`product-${rowIndex(row)}`"
              >{{ row.product.name }}</span
            >
            <br />
            <span class="small">
              <code>{{ row.product.sku }}</code>
              <template v-if="row.product.stockQuantity !== null">
                · {{ row.product.stockQuantity }} in stock</template
              >
            </span>
          </template>
          <span v-else :id="fieldId(row.line.key, 'name')" class="muted"
            >No product (remove this line)</span
          >
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
      <Column>
        <template #header><span :id="headerId('qty')">Qty</span></template>
        <template #body="{ data: row }">
          <InputText
            :id="fieldId(row.line.key, 'qty')"
            :aria-labelledby="inputLabelledBy(row.line.key, 'qty')"
            class="qty"
            inputmode="numeric"
            :model-value="row.line.quantityInput"
            :invalid="Boolean(row.errors.quantity)"
            :aria-describedby="qtyDescribedBy(row)"
            @update:model-value="draft.setQuantity(row.line.key, $event ?? '')"
          />
        </template>
      </Column>
      <Column header="Markup %">
        <template #body="{ data: row }">
          <span :data-testid="`markup-${rowIndex(row)}`">{{
            markupText(row)
          }}</span>
        </template>
      </Column>
      <Column :header="`Processing fee (${feePercent})`">
        <template #body="{ data: row }">
          <span :data-testid="`fee-${rowIndex(row)}`">
            <MoneyText :cents="row.lineFeeCents ?? 0" />
          </span>
        </template>
      </Column>
      <Column header="Patient price (each)">
        <template #body="{ data: row }">
          <span
            :data-testid="`price-${rowIndex(row)}`"
            :class="{ negative: row.belowMinimum }"
            >{{
              row.priceCents === null ? '—' : formatCents(row.priceCents)
            }}</span
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
        <template #header
          ><span class="visually-hidden">Actions</span></template
        >
        <template #body="{ data: row }">
          <Button
            v-if="row.product"
            :id="fieldId(row.line.key, 'edit')"
            icon="pi pi-pencil"
            severity="secondary"
            text
            :aria-label="`Edit ${row.product.name}`"
            @click="openEditLine(row)"
          />
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
    <div aria-live="polite" data-testid="order-line-errors">
      <ul
        v-if="tableErrors.length"
        class="errors"
        aria-label="Order line errors"
      >
        <li v-for="item in tableErrors" :id="item.id" :key="item.id">
          {{ item.text }}
        </li>
      </ul>
    </div>
    <div aria-live="polite" data-testid="order-line-warnings">
      <ul
        v-if="tableWarnings.length"
        class="warnings"
        aria-label="Order line warnings"
      >
        <li v-for="item in tableWarnings" :id="item.id" :key="item.id">
          {{ item.text }}
        </li>
      </ul>
    </div>
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
      :editing="editingLine"
      @close="closeAddProduct"
      @add="addFromDialog"
      @save="saveFromDialog"
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
        :disabled="saving || deleting"
        @click="saveDraft"
      />
      <Button
        label="Send to patient"
        :disabled="saving || deleting || !canSend"
        @click="sendToPatient"
      />
      <Button
        v-if="orderId !== null"
        label="Delete draft"
        severity="danger"
        outlined
        :disabled="saving || deleting"
        @click="confirmDelete"
      />
    </div>
    <Dialog
      :visible="lowStockPrompt !== null"
      modal
      header="Send with limited stock?"
      :draggable="false"
      :style="{ width: 'min(36rem, 95vw)' }"
      :pt="{ title: { role: 'heading', 'aria-level': 2 } }"
      @update:visible="lowStockPrompt = null"
    >
      <ul>
        <li v-for="item in lowStockPrompt" :key="item.name">
          {{ item.name }}: {{ item.quantity }} requested,
          {{ item.available }} in stock
        </li>
      </ul>
      <p>
        The patient can pay for what's in stock now. The rest will become a
        separate back-order they can pay when stock returns.
      </p>
      <div class="actions">
        <Button label="Send anyway" :disabled="saving" @click="sendAnyway" />
        <Button
          label="Back to order"
          severity="secondary"
          @click="lowStockPrompt = null"
        />
      </div>
    </Dialog>
    <p aria-live="polite" class="status">
      {{ status }}
    </p>
  </template>
</template>
