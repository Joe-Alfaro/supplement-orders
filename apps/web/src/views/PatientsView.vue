<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { searchPatients } from '../api'
import { ErrorBanner, PaginationControls, StatusBadge } from '../components'
import { usePagedSearch } from '../search'

const route = useRoute()
const router = useRouter()

const initialQuery = typeof route.query.q === 'string' ? route.query.q : ''
const search = usePagedSearch(searchPatients, { initialQuery })
const { query, activeQuery, items, page, loading, error } = search

onMounted(search.load)

// Keep the search in the URL so it survives reload and back navigation.
watch(activeQuery, (q) => {
  router.replace({ query: q ? { q } : {} })
})

function openPatient(patientId: number) {
  router.push(`/patients/${patientId}`)
}

function onInput(event: Event) {
  search.setQuery((event.target as HTMLInputElement).value)
}
</script>

<template>
  <h1>Patients</h1>
  <p class="search">
    <label for="patient-search">Search patients</label><br />
    <input
      id="patient-search"
      type="search"
      placeholder="Name or address"
      :value="query"
      @input="onInput"
    />
  </p>
  <ErrorBanner v-if="error" :message="error" retryable @retry="search.load" />
  <p v-else-if="loading && !page">Loading…</p>
  <template v-else-if="page">
    <p v-if="items.length === 0" role="status">
      <template v-if="activeQuery">
        No patients match "{{ activeQuery }}".
        <button type="button" @click="search.clear">Clear search</button>
      </template>
      <template v-else>No patients yet.</template>
    </p>
    <template v-else>
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Address</th>
            <th scope="col">Orders</th>
            <th scope="col">Latest order</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="patient in items"
            :key="patient.id"
            class="row-link"
            tabindex="0"
            @click="openPatient(patient.id)"
            @keydown.enter="openPatient(patient.id)"
          >
            <td>{{ patient.name }}</td>
            <td class="small">{{ patient.address }}</td>
            <td class="num">{{ patient.orderCount }}</td>
            <td>
              <StatusBadge
                v-if="patient.latestOrderStatus"
                :status="patient.latestOrderStatus"
              />
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
    <PaginationControls
      :offset="search.offset.value"
      :count="items.length"
      :total="search.total.value"
      :can-previous="search.canPrevious.value"
      :can-next="search.canNext.value"
      label="patients"
      @previous="search.previous"
      @next="search.next"
    />
  </template>
</template>
