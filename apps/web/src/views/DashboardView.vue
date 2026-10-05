<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getDashboard, searchProducts } from '../api'
import {
  ErrorBanner,
  MoneyText,
  PaginationControls,
  StatTile,
} from '../components'
import { formatDate } from '../format'
import { usePagedSearch } from '../search'
import { useResource } from '../useResource'

const router = useRouter()
const sales = useResource(getDashboard)
// Read-only: stock only changes when orders are paid.
const inventory = usePagedSearch(searchProducts)

onMounted(() => {
  sales.load()
  inventory.load()
})

function onInventorySearch(event: Event) {
  inventory.setQuery((event.target as HTMLInputElement).value)
}

function openOrder(orderId: number) {
  router.push(`/orders/${orderId}`)
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
            <th scope="col">Wholesale cost</th>
            <th scope="col">Platform fee</th>
            <th scope="col">Your margin</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="order in sales.data.value.paidOrders"
            :key="order.orderId"
            class="row-link"
            tabindex="0"
            @click="openOrder(order.orderId)"
            @keydown.enter="openOrder(order.orderId)"
          >
            <td>{{ formatDate(order.paidAt) }}</td>
            <td>{{ order.patientName }}</td>
            <td><MoneyText :cents="order.totalCents" /></td>
            <td><MoneyText :cents="order.cogsCents" /></td>
            <td><MoneyText :cents="order.platformFeeCents" /></td>
            <td><MoneyText :cents="order.providerMarginCents" /></td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>

  <section aria-labelledby="inventory-heading">
    <h2 id="inventory-heading">Inventory</h2>
    <p class="muted">
      Stock decreases automatically when orders are paid. It is not edited by
      hand.
    </p>
    <p class="search">
      <label for="inventory-search">Search products</label><br />
      <input
        id="inventory-search"
        type="search"
        placeholder="Name or SKU"
        :value="inventory.query.value"
        @input="onInventorySearch"
      />
    </p>
    <ErrorBanner
      v-if="inventory.error.value"
      :message="inventory.error.value"
      retryable
      @retry="inventory.load"
    />
    <p v-else-if="inventory.loading.value && !inventory.page.value">Loading…</p>
    <template v-else-if="inventory.page.value">
      <p v-if="inventory.items.value.length === 0" role="status">
        <template v-if="inventory.activeQuery.value"
          >No products match "{{ inventory.activeQuery.value }}".</template
        >
        <template v-else>No products.</template>
      </p>
      <table v-else>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">SKU</th>
            <th scope="col">Wholesale cost</th>
            <th scope="col">Stock on hand</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="product in inventory.items.value" :key="product.id">
            <td>{{ product.name }}</td>
            <td>
              <code>{{ product.sku }}</code>
            </td>
            <td><MoneyText :cents="product.cogsCents" /></td>
            <td class="num">{{ product.stockQuantity }}</td>
          </tr>
        </tbody>
      </table>
      <PaginationControls
        :offset="inventory.offset.value"
        :count="inventory.items.value.length"
        :total="inventory.total.value"
        :can-previous="inventory.canPrevious.value"
        :can-next="inventory.canNext.value"
        label="products"
        @previous="inventory.previous"
        @next="inventory.next"
      />
    </template>
  </section>
</template>
