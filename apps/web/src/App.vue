<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { UserSwitcher } from './components'
import { notice, useCurrentUser } from './user'

const { currentUser } = useCurrentUser()
</script>

<template>
  <header class="app-header">
    <strong>Supplement Orders</strong>
    <nav v-if="currentUser" aria-label="Main">
      <template v-if="currentUser.role === 'provider'">
        <RouterLink to="/patients">Patients</RouterLink>
        <RouterLink to="/dashboard">Dashboard</RouterLink>
      </template>
      <RouterLink v-else to="/my-orders">My Orders</RouterLink>
    </nav>
    <UserSwitcher />
  </header>
  <div aria-live="polite">
    <p v-if="notice" class="banner">{{ notice.message }}</p>
  </div>
  <main>
    <RouterView />
  </main>
</template>
