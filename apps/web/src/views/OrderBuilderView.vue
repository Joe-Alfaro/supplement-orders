<script setup lang="ts">
import type { PatientDto } from '@supplement-orders/domain'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ApiRequestError,
  createOrder,
  errorMessage,
  getOrder,
  getPatient,
  replaceOrderLines,
  sendOrder,
} from '../api'
import { useOrderDraft, type NewLine } from '../builder'
import {
  AddProductDialog,
  ErrorBanner,
  MoneyText,
  SplitSummary,
} from '../components'
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
    loadError.value = errorMessage(err)
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
  banner.value = errorMessage(err)
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
const addLineButton = ref<HTMLButtonElement | null>(null)

function openAddProduct() {
  dialogOpen.value = true
}

/** Closing the modal any way returns focus to Add line. */
async function closeAddProduct() {
  dialogOpen.value = false
  await nextTick()
  addLineButton.value?.focus()
}

/** The new line appears in the table and its Qty input takes focus. */
async function addFromDialog(line: NewLine) {
  const key = draft.addLine(line)
  dialogOpen.value = false
  await nextTick()
  document.getElementById(fieldId(key, 'qty'))?.focus()
}

function inputValue(event: Event) {
  return (event.target as HTMLInputElement).value
}

function fieldId(key: number, field: string) {
  return `line-${key}-${field}`
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
      <template v-if="patient">for {{ patient.name }}</template>
    </h1>

    <ErrorBanner v-if="banner" :message="banner" />

    <table v-if="lines.length > 0" class="builder">
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Wholesale cost</th>
          <th scope="col">Qty</th>
          <th scope="col">Margin %</th>
          <th scope="col">Patient price (each)</th>
          <th scope="col">Line total</th>
          <th scope="col"><span class="visually-hidden">Remove</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in evaluated" :key="row.line.key">
          <td>
            <template v-if="row.product">
              <span :data-testid="`product-${index}`">{{
                row.product.name
              }}</span>
              <br />
              <span class="small">
                <code>{{ row.product.sku }}</code> ·
                {{
                  row.product.stockQuantity === null
                    ? 'stock checked on send'
                    : `${row.product.stockQuantity} in stock`
                }}
              </span>
            </template>
            <span v-else class="muted">No product (remove this line)</span>
            <p
              v-if="row.errors.productId"
              :id="fieldId(row.line.key, 'product-error')"
              class="field-error"
            >
              {{ row.errors.productId }}
            </p>
          </td>
          <td>
            <MoneyText v-if="row.product" :cents="row.product.cogsCents" />
            <span v-else>—</span>
          </td>
          <td>
            <label :for="fieldId(row.line.key, 'qty')" class="visually-hidden"
              >Quantity for line {{ index + 1 }}</label
            >
            <input
              :id="fieldId(row.line.key, 'qty')"
              class="qty"
              type="number"
              min="1"
              step="1"
              :max="row.product?.stockQuantity ?? undefined"
              :value="row.line.quantityInput"
              :aria-invalid="row.errors.quantity ? 'true' : undefined"
              :aria-describedby="
                row.errors.quantity
                  ? fieldId(row.line.key, 'qty-error')
                  : undefined
              "
              @input="draft.setQuantity(row.line.key, inputValue($event))"
            />
            <p
              v-if="row.errors.quantity"
              :id="fieldId(row.line.key, 'qty-error')"
              class="field-error"
            >
              {{ row.errors.quantity }}
            </p>
          </td>
          <td>
            <label
              :for="fieldId(row.line.key, 'margin')"
              class="visually-hidden"
              >Margin % for line {{ index + 1 }}</label
            >
            <input
              :id="fieldId(row.line.key, 'margin')"
              class="margin"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
              :value="row.line.marginInput"
              :class="{ negative: row.line.marginInput.startsWith('-') }"
              :aria-invalid="row.errors.margin ? 'true' : undefined"
              :aria-describedby="
                row.errors.margin
                  ? fieldId(row.line.key, 'margin-error')
                  : undefined
              "
              @input="draft.setMargin(row.line.key, inputValue($event))"
              @blur="draft.normalizeMargin(row.line.key)"
            /><span aria-hidden="true">%</span>
            <p
              v-if="row.errors.margin"
              :id="fieldId(row.line.key, 'margin-error')"
              class="field-error"
            >
              {{ row.errors.margin }}
            </p>
          </td>
          <td>
            <label :for="fieldId(row.line.key, 'price')" class="visually-hidden"
              >Patient price for line {{ index + 1 }}</label
            >
            <span class="dollar" aria-hidden="true">$</span>
            <input
              :id="fieldId(row.line.key, 'price')"
              class="price"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
              :value="row.line.priceInput"
              :aria-invalid="
                row.errors.unitPriceCents || row.belowMinimum
                  ? 'true'
                  : undefined
              "
              :aria-describedby="`${fieldId(row.line.key, 'price-min')} ${fieldId(row.line.key, 'price-error')}`"
              @input="draft.setPrice(row.line.key, inputValue($event))"
              @blur="draft.normalizePrice(row.line.key)"
            />
            <p
              v-if="row.minPriceCents !== null"
              :id="fieldId(row.line.key, 'price-min')"
              class="hint"
              :class="{ negative: row.belowMinimum }"
              :data-testid="`min-${index}`"
            >
              Min {{ formatCents(row.minPriceCents) }}
            </p>
            <p
              v-if="row.errors.unitPriceCents"
              :id="fieldId(row.line.key, 'price-error')"
              class="field-error"
            >
              {{ row.errors.unitPriceCents }}
            </p>
          </td>
          <td>
            <MoneyText
              v-if="row.lineTotalCents !== null"
              :cents="row.lineTotalCents"
            />
            <span v-else>—</span>
          </td>
          <td>
            <button type="button" @click="draft.removeLine(row.line.key)">
              Remove<span class="visually-hidden"> line {{ index + 1 }}</span>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="lines.length === 0">No lines yet. Add a product to start.</p>
    <p>
      <button ref="addLineButton" type="button" @click="openAddProduct">
        Add line
      </button>
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
      minimum) to see the split. The platform fee is {{ feePercent }} of the
      order and comes out of your margin.
    </p>

    <p class="actions">
      <button type="button" :disabled="saving" @click="saveDraft">
        Save draft
      </button>
      <button
        type="button"
        class="primary"
        :disabled="saving || !canSend"
        @click="sendToPatient"
      >
        Send to patient
      </button>
    </p>
    <p aria-live="polite" class="status">{{ status }}</p>
  </template>
</template>
