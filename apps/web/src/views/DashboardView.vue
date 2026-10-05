<script setup lang="ts">
import type { ProductDto } from '@supplement-orders/domain'
import { onMounted, reactive } from 'vue'
import {
  errorMessage,
  getDashboard,
  listProducts,
  updateProductStock,
} from '../api'
import { ErrorBanner, MoneyText, StatTile } from '../components'
import { formatDate } from '../format'
import { useResource } from '../useResource'

const sales = useResource(getDashboard)

interface StockRow {
  input: string
  saving: boolean
  status: string | null
  error: string | null
}

const stockRows = reactive<Record<number, StockRow>>({})

const inventory = useResource(async () => {
  const products = await listProducts()
  products.forEach((product) => {
    stockRows[product.id] = {
      input: String(product.stockQuantity),
      saving: false,
      status: null,
      error: null,
    }
  })
  return products
})

onMounted(() => {
  sales.load()
  inventory.load()
})

function rowFor(product: ProductDto): StockRow {
  const row = stockRows[product.id]
  if (!row) throw new Error(`No stock row for product ${product.id}`)
  return row
}

function setStockInput(product: ProductDto, event: Event) {
  const row = rowFor(product)
  row.input = (event.target as HTMLInputElement).value
  row.status = null
}

async function saveStock(product: ProductDto) {
  const row = rowFor(product)
  row.status = null
  const input = row.input.trim()
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input))) {
    row.error = 'Enter a whole number of 0 or more'
    return
  }
  row.error = null
  row.saving = true
  try {
    const updated = await updateProductStock(product.id, Number(input))
    row.input = String(updated.stockQuantity)
    row.status = 'Saved'
  } catch (err) {
    row.error = errorMessage(err)
  } finally {
    row.saving = false
  }
}
</script>

<template>
  <h1>Dashboard</h1>

  <section aria-labelledby="sales-heading">
    <h2 id="sales-heading">Sales</h2>
    <p v-if="sales.loading.value">Loading…</p>
    <ErrorBanner
      v-else-if="sales.error.value"
      :message="sales.error.value"
      retryable
      @retry="sales.load"
    />
    <template v-else-if="sales.data.value">
      <div class="tiles">
        <StatTile label="GMV" :cents="sales.data.value.gmvCents" />
        <StatTile
          label="Your margin earned"
          :cents="sales.data.value.providerMarginCents"
        />
        <StatTile
          label="Platform fees collected"
          :cents="sales.data.value.platformFeeCents"
        />
      </div>
      <p v-if="sales.data.value.paidOrders.length === 0">No paid orders yet.</p>
      <table v-else>
        <thead>
          <tr>
            <th scope="col">Paid</th>
            <th scope="col">Patient</th>
            <th scope="col">Patient total</th>
            <th scope="col">COGS</th>
            <th scope="col">Your margin</th>
            <th scope="col">Platform fee</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="order in sales.data.value.paidOrders" :key="order.orderId">
            <td>
              <RouterLink :to="`/orders/${order.orderId}`">{{
                formatDate(order.paidAt)
              }}</RouterLink>
            </td>
            <td>{{ order.patientName }}</td>
            <td><MoneyText :cents="order.totalCents" /></td>
            <td><MoneyText :cents="order.cogsCents" /></td>
            <td><MoneyText :cents="order.providerMarginCents" /></td>
            <td><MoneyText :cents="order.platformFeeCents" /></td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>

  <section aria-labelledby="inventory-heading">
    <h2 id="inventory-heading">Inventory</h2>
    <p v-if="inventory.loading.value">Loading…</p>
    <ErrorBanner
      v-else-if="inventory.error.value"
      :message="inventory.error.value"
      retryable
      @retry="inventory.load"
    />
    <template v-else-if="inventory.data.value">
      <p v-if="inventory.data.value.length === 0">No products.</p>
      <table v-else>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">SKU</th>
            <th scope="col">Our cost</th>
            <th scope="col">Stock</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="product in inventory.data.value" :key="product.id">
            <td>{{ product.name }}</td>
            <td>
              <code>{{ product.sku }}</code>
            </td>
            <td><MoneyText :cents="product.cogsCents" /></td>
            <td>
              <label>
                <span class="visually-hidden"
                  >Stock for {{ product.name }}</span
                >
                <input
                  :value="rowFor(product).input"
                  type="number"
                  min="0"
                  step="1"
                  inputmode="numeric"
                  :aria-invalid="rowFor(product).error ? 'true' : undefined"
                  @input="setStockInput(product, $event)"
                />
              </label>
            </td>
            <td>
              <button
                type="button"
                :disabled="rowFor(product).saving"
                @click="saveStock(product)"
              >
                Save
              </button>
              <span aria-live="polite">
                <span v-if="rowFor(product).error" class="negative">{{
                  rowFor(product).error
                }}</span>
                <span v-else-if="rowFor(product).status" class="ok">{{
                  rowFor(product).status
                }}</span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
