<script setup lang="ts">
import { useCurrentUser } from '../user'

const { loadError } = useCurrentUser()
</script>

<template>
  <h1>Supplement orders</h1>
  <p v-if="loadError" role="alert">Could not load users: {{ loadError }}</p>
  <p v-else>Choose a user from the switcher above to get started.</p>
</template>
