<script setup lang="ts">
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'
import Dialog from 'primevue/dialog'
import { useConfirm } from 'primevue/useconfirm'
import { computed, ref, watch } from 'vue'
import {
  handleApiError,
  resetDefaultPrice,
  setDefaultPrice,
  type ProviderProductDto,
} from '../api'
import { centsToInput, usePricingForm } from '../builder'
import { useSuccessToast } from '../toast'
import ErrorBanner from './ErrorBanner.vue'
import MoneyText from './MoneyText.vue'
import PricingFields from './PricingFields.vue'

interface Props {
  /** The product being priced; null keeps the dialog closed. */
  product: ProviderProductDto | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  saved: [product: ProviderProductDto]
}>()

const confirm = useConfirm()
const showSuccess = useSuccessToast()

const chosen = computed(() => props.product)
// Qty is fixed at 1: a default is a per-unit price.
const form = usePricingForm(chosen, {
  idPrefix: 'default-price',
  fixedQuantity: true,
  requirePrice: true,
})
const busy = ref(false)
const banner = ref<string | null>(null)

watch(
  () => props.product?.id,
  () => {
    const product = props.product
    banner.value = null
    if (!product) return
    form.startAtPrice(product, centsToInput(product.defaultUnitPriceCents))
  },
  { immediate: true },
)

const title = computed(() => `Set default price for ${props.product?.name}`)

function onVisible(visible: boolean) {
  if (!visible) emit('close')
}

async function store(
  action: () => Promise<ProviderProductDto>,
  message: string,
) {
  busy.value = true
  banner.value = null
  try {
    const updated = await action()
    showSuccess(message)
    emit('saved', updated)
    emit('close')
  } catch (err) {
    banner.value = handleApiError(err)
  } finally {
    busy.value = false
  }
}

function save() {
  form.attempted = true
  const product = props.product
  const cents = form.pricing.priceCents
  if (!product || cents === null || !form.pricing.saveable) return
  if (form.belowMinimumError) return
  store(() => setDefaultPrice(product.id, cents), 'Default price saved')
}

function askReset() {
  const product = props.product
  if (!product) return
  confirm.require({
    group: 'default-price',
    header: 'Reset to minimum',
    message: `Reset the default price for ${product.name} to its minimum of ${centsToInput(form.pricing.minPriceCents ?? 0).replace(/^/, '$')}?`,
    defaultFocus: 'reject',
    rejectProps: { label: 'Keep', severity: 'secondary' },
    acceptProps: { label: 'Reset' },
    accept: () =>
      store(() => resetDefaultPrice(product.id), 'Default price reset'),
  })
}
</script>

<template>
  <ConfirmDialog group="default-price" />
  <Dialog
    :visible="product !== null"
    modal
    :header="title"
    :draggable="false"
    :style="{ width: 'min(48rem, 95vw)' }"
    :pt="{ title: { role: 'heading', 'aria-level': 2 } }"
    @update:visible="onVisible"
  >
    <form v-if="product" @submit.prevent="save">
      <dl class="facts">
        <dt>SKU</dt>
        <dd>
          <code>{{ product.sku }}</code>
        </dd>
        <dt>Wholesale cost</dt>
        <dd><MoneyText :cents="product.cogsCents" /></dd>
        <dt>Minimum price</dt>
        <dd>
          <MoneyText
            v-if="form.pricing.minPriceCents !== null"
            :cents="form.pricing.minPriceCents"
          />
        </dd>
      </dl>
      <PricingFields
        :form="form"
        id-prefix="default-price"
        :show-quantity="false"
      />
      <ErrorBanner v-if="banner" :message="banner" />
      <div class="actions">
        <Button type="submit" label="Save default price" :loading="busy" />
        <Button
          label="Reset to minimum"
          severity="secondary"
          outlined
          :disabled="busy"
          @click="askReset"
        />
        <Button
          label="Cancel"
          severity="secondary"
          text
          @click="emit('close')"
        />
      </div>
    </form>
  </Dialog>
</template>
