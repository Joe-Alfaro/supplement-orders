<script setup lang="ts">
import { onMounted } from 'vue'
import { listPatients } from '../api'
import { ErrorBanner, StatusBadge } from '../components'
import { useResource } from '../useResource'

const { data: patients, loading, error, load } = useResource(listPatients)
onMounted(load)
</script>

<template>
  <h1>Patients</h1>
  <p v-if="loading">Loading…</p>
  <ErrorBanner v-else-if="error" :message="error" retryable @retry="load" />
  <template v-else-if="patients">
    <p v-if="patients.length === 0">No patients yet.</p>
    <table v-else>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Orders</th>
          <th scope="col">Latest order</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="patient in patients" :key="patient.id">
          <td>
            <RouterLink :to="`/patients/${patient.id}`">{{
              patient.name
            }}</RouterLink>
          </td>
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
</template>
