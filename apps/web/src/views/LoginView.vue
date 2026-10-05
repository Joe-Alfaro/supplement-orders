<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ErrorBanner } from '../components'
import { homePathFor, roleLabel, useCurrentUser } from '../user'

const router = useRouter()
const { users, loadError, ensureUsersLoaded, signIn } = useCurrentUser()
const selectedId = ref('')

async function submit() {
  const user = users.value.find(
    (candidate) => String(candidate.id) === selectedId.value,
  )
  if (!user) return
  signIn(user.id)
  await router.push(homePathFor(user.role))
}
</script>

<template>
  <section class="login" aria-labelledby="login-heading">
    <h1 id="login-heading">Sign in</h1>
    <p class="banner" role="note">
      Authentication is stubbed for this demo: choose a user to continue.
    </p>
    <ErrorBanner
      v-if="loadError"
      :message="`Could not load users: ${loadError}`"
      retryable
      @retry="ensureUsersLoaded"
    />
    <form @submit.prevent="submit">
      <p>
        <label for="login-user">User</label><br />
        <select id="login-user" v-model="selectedId">
          <option value="" disabled>Choose a user…</option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            {{ user.name }} ({{ roleLabel(user.role) }})
          </option>
        </select>
      </p>
      <p>
        <button type="submit" class="primary" :disabled="selectedId === ''">
          Sign in
        </button>
      </p>
    </form>
  </section>
</template>
