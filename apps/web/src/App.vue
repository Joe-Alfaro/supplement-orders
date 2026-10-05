<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { notice, roleLabel, useCurrentUser } from './user'

const router = useRouter()
const { currentUser, signOut } = useCurrentUser()

async function onSignOut() {
  signOut()
  await router.push('/login')
}
</script>

<template>
  <header v-if="currentUser" class="app-header">
    <strong>Supplement Orders</strong>
    <nav aria-label="Main">
      <template v-if="currentUser.role === 'provider'">
        <RouterLink to="/patients">Patients</RouterLink>
        <RouterLink to="/dashboard">Dashboard</RouterLink>
      </template>
      <RouterLink v-else to="/my-orders">My Orders</RouterLink>
    </nav>
    <span class="signed-in">
      Signed in as {{ currentUser.name }} ({{ roleLabel(currentUser.role) }}) ·
      <button type="button" class="link-button" @click="onSignOut">
        Sign out
      </button>
    </span>
  </header>
  <div aria-live="polite">
    <p v-if="notice" class="banner">{{ notice.message }}</p>
  </div>
  <main>
    <RouterView />
  </main>
</template>
