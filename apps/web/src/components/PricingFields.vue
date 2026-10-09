<script setup lang="ts">
import InputText from 'primevue/inputtext'
import { computed } from 'vue'
import type { PricingForm } from '../builder'
import { formatCents, PLATFORM_FEE_BPS } from '../money'

interface Props {
  form: PricingForm
  /** Prefix of every input id; also the prefix `form` was built with. */
  idPrefix: string
  /** Qty is an input here; the default-price dialog prices one unit. */
  showQuantity?: boolean
  /** Extra id (e.g. a stock note) for the Qty input when it has no error. */
  qtyNoteId?: string
}

const props = withDefaults(defineProps<Props>(), {
  showQuantity: true,
  qtyNoteId: undefined,
})

const feeLabel = `Processing fee (${PLATFORM_FEE_BPS / 100}%)`

const qtyDescribedBy = computed(() => {
  if (props.form.pricing.errors.quantity) return `${props.idPrefix}-qty-error`
  return props.qtyNoteId
})

const markupDescribedBy = computed(
  () =>
    [
      props.form.zeroCost ? `${props.idPrefix}-markup-na` : '',
      props.form.pricing.errors.markup ? `${props.idPrefix}-markup-error` : '',
    ]
      .join(' ')
      .trim() || undefined,
)
</script>

<template>
  <div class="fields">
    <div v-if="showQuantity" class="field">
      <label :for="`${idPrefix}-qty`">Qty</label>
      <InputText
        :id="`${idPrefix}-qty`"
        class="qty"
        inputmode="numeric"
        :model-value="form.quantityInput"
        :invalid="Boolean(form.pricing.errors.quantity)"
        :aria-describedby="qtyDescribedBy"
        @update:model-value="form.onQuantity($event ?? '')"
      />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-markup`">Markup %</label>
      <InputText
        :id="`${idPrefix}-markup`"
        class="markup"
        inputmode="decimal"
        :placeholder="form.zeroCost ? '—' : '0.00'"
        :disabled="form.zeroCost"
        :model-value="form.markupInput"
        :invalid="Boolean(form.pricing.errors.markup)"
        :aria-describedby="markupDescribedBy"
        @update:model-value="form.onMarkup($event ?? '')"
        @blur="form.normalizeMarkup()"
      />
      <small v-if="form.zeroCost" :id="`${idPrefix}-markup-na`" class="hint"
        >No markup on a $0 cost; enter the price.</small
      >
    </div>
    <div class="field">
      <!-- Read-only by nature: plain text in a labelled <output>, not a control. -->
      <label :for="`${idPrefix}-fee`">{{ feeLabel }}</label>
      <output :id="`${idPrefix}-fee`" class="fee-value" aria-live="polite">{{
        formatCents(form.pricing.lineFeeCents ?? 0)
      }}</output>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-price`">Patient price (each)</label>
      <InputText
        :id="`${idPrefix}-price`"
        class="price"
        inputmode="decimal"
        placeholder="0.00"
        :model-value="form.priceInput"
        :invalid="Boolean(form.priceError) || form.pricing.belowMinimum"
        :aria-describedby="
          form.priceError ? `${idPrefix}-price-error` : undefined
        "
        @update:model-value="form.onPrice($event ?? '')"
        @blur="form.normalizePrice()"
      />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-margin`">Your margin</label>
      <output
        :id="`${idPrefix}-margin`"
        class="fee-value"
        :class="{ negative: (form.pricing.lineMarginCents ?? 0) < 0 }"
        aria-live="polite"
        >{{ formatCents(form.pricing.lineMarginCents ?? 0) }}</output
      >
    </div>
  </div>
  <div aria-live="polite" :data-testid="`${idPrefix}-errors`">
    <ul v-if="form.errorItems.length" class="errors" aria-label="Errors">
      <li v-for="item in form.errorItems" :id="item.id" :key="item.id">
        {{ item.label }} - {{ item.text }}
      </li>
    </ul>
  </div>
</template>
