<script setup lang="ts">
import type { PatientDto, ProductDto } from '@supplement-orders/domain'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ApiRequestError,
  createOrder,
  errorMessage,
  getOrder,
  getPatient,
  listProducts,
  replaceOrderLines,
  sendOrder,
} from '../api'
import { useOrderDraft } from '../builder'
import { ErrorBanner, MoneyText, SplitSummary } from '../components'

interface Props {
  patientId: string
  /** Set when reopening an existing draft. */
  orderId?: string
}

const props = defineProps<Props>()
const router = useRouter()

const patientId = computed(() => Number(props.patientId))
const orderId = ref<number | null>(props.orderId ? Number(props.orderId) : null)

const products = ref<ProductDto[]>([])
const patient = ref<PatientDto | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const saving = ref(false)
const status = ref<string | null>(null)
const banner = ref<string | null>(null)

const draft = useOrderDraft(products)
const { lines, evaluated, split, canSend } = draft

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [loadedProducts, loadedPatient, existing] = await Promise.all([
      listProducts(),
      getPatient(patientId.value),
      orderId.value === null ? null : getOrder(orderId.value),
    ])
    products.value = loadedProducts
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
  draft.showAllErrors.value = true
  if (!draft.canSaveDraft.value) {
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

function selectProduct(key: number, event: Event) {
  const { value } = event.target as HTMLSelectElement
  draft.updateLine(key, { productId: value === '' ? null : Number(value) })
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

    <table class="builder">
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Wholesale cost</th>
          <th scope="col">Qty</th>
          <th scope="col">Patient price (each)</th>
          <th scope="col">Your margin (each)</th>
          <th scope="col">Line total</th>
          <th scope="col"><span class="visually-hidden">Remove</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in evaluated" :key="row.line.key">
          <td>
            <label
              :for="fieldId(row.line.key, 'product')"
              class="visually-hidden"
              >Product for line {{ index + 1 }}</label
            >
            <select
              :id="fieldId(row.line.key, 'product')"
              :value="row.line.productId ?? ''"
              :aria-invalid="row.errors.productId ? 'true' : undefined"
              :aria-describedby="
                row.errors.productId
                  ? fieldId(row.line.key, 'product-error')
                  : undefined
              "
              @change="selectProduct(row.line.key, $event)"
            >
              <option value="">Choose a product…</option>
              <option
                v-for="product in draft.optionsFor(row.line)"
                :key="product.id"
                :value="product.id"
              >
                {{ product.name }} ({{ product.stockQuantity }} in stock)
              </option>
            </select>
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
              :max="row.product?.stockQuantity"
              :value="row.line.quantityInput"
              :aria-invalid="row.errors.quantity ? 'true' : undefined"
              :aria-describedby="
                row.errors.quantity
                  ? fieldId(row.line.key, 'qty-error')
                  : undefined
              "
              @input="
                draft.updateLine(row.line.key, {
                  quantityInput: inputValue($event),
                })
              "
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
            <label :for="fieldId(row.line.key, 'price')" class="visually-hidden"
              >Patient price for line {{ index + 1 }}</label
            >
            <span class="dollar">$</span>
            <input
              :id="fieldId(row.line.key, 'price')"
              class="price"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
              :value="row.line.priceInput"
              :aria-invalid="row.errors.unitPriceCents ? 'true' : undefined"
              :aria-describedby="
                row.errors.unitPriceCents
                  ? fieldId(row.line.key, 'price-error')
                  : undefined
              "
              @input="
                draft.updateLine(row.line.key, {
                  priceInput: inputValue($event),
                })
              "
              @blur="draft.blurPrice(row.line.key)"
            />
            <p
              v-if="row.errors.unitPriceCents"
              :id="fieldId(row.line.key, 'price-error')"
              class="field-error"
            >
              {{ row.errors.unitPriceCents }}
            </p>
          </td>
          <td :data-testid="`margin-${index}`">
            <MoneyText
              v-if="row.marginCents !== null"
              :cents="row.marginCents"
            />
            <span v-else>—</span>
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
    <p v-if="lines.length === 0">No lines yet.</p>
    <p>
      <button type="button" @click="draft.addLine">Add line</button>
    </p>

    <h2>Split summary</h2>
    <SplitSummary v-if="split.ok" :split="split.split" />
    <p v-else class="muted">{{ split.message }}</p>

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
