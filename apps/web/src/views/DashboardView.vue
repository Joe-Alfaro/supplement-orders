<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getDashboard, listProducts } from '../api'
import { ErrorBanner, MoneyText, StatTile } from '../components'
import { formatDate } from '../format'
import { useResource } from '../useResource'

const router = useRouter()
const sales = useResource(getDashboard)
// Read-only: stock only changes when orders are paid.
const inventory = useResource(listProducts)

onMounted(() => {
  sales.load()
  inventory.load()
})

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
            <th scope="col">Wholesale cost</th>
            <th scope="col">Stock on hand</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="product in inventory.data.value" :key="product.id">
            <td>{{ product.name }}</td>
            <td>
              <code>{{ product.sku }}</code>
            </td>
            <td><MoneyText :cents="product.cogsCents" /></td>
            <td class="num">{{ product.stockQuantity }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
