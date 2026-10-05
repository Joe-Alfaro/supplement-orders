<script setup lang="ts">
import { useRouter } from 'vue-router'
import { homePathFor, roleLabel, useCurrentUser } from '../user'

const router = useRouter()
const { users, currentUser, selectUser } = useCurrentUser()

function onChange(event: Event) {
  const { value } = event.target as HTMLSelectElement
  const user = users.value.find((candidate) => String(candidate.id) === value)
  selectUser(user?.id ?? null)
  router.push(user ? homePathFor(user.role) : '/')
}
</script>

<template>
  <label class="switcher">
    Acting as
    <select :value="currentUser?.id ?? ''" @change="onChange">
      <option value="" disabled>Choose a user…</option>
      <option v-for="user in users" :key="user.id" :value="user.id">
        {{ user.name }} ({{ roleLabel(user.role) }})
      </option>
    </select>
  </label>
</template>
