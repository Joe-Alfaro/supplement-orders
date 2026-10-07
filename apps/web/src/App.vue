<script setup lang="ts">
import Button from 'primevue/button'
import Message from 'primevue/message'
import Toast from 'primevue/toast'
import { watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { notice, roleLabel, useCurrentUser } from './user'

const router = useRouter()
const route = useRoute()
const { currentUser, signOut } = useCurrentUser()

// Signed out from anywhere (e.g. the API rejected the user): go to the login screen.
watch(currentUser, (user) => {
  if (!user && route.name !== 'login') router.replace({ name: 'login' })
})

async function onSignOut() {
  signOut()
  await router.push('/login')
}
</script>

<template>
  <Toast position="top-right" />
  <header v-if="currentUser" class="app-header">
    <div class="app-header-inner page-column">
      <strong>Supplement Orders</strong>
      <nav aria-label="Main">
        <template v-if="currentUser.role === 'provider'">
          <RouterLink to="/patients">Patients</RouterLink>
          <RouterLink to="/orders">Orders</RouterLink>
          <RouterLink to="/dashboard">Dashboard</RouterLink>
        </template>
        <RouterLink
          v-else-if="currentUser.role === 'admin'"
          to="/admin/inventory"
          >Inventory</RouterLink
        >
        <RouterLink v-else to="/my-orders">My Orders</RouterLink>
      </nav>
      <span class="signed-in">
        Signed in as {{ currentUser.name }} ({{ roleLabel(currentUser.role) }})
        ·
        <Button label="Sign out" link size="small" @click="onSignOut" />
      </span>
    </div>
  </header>
  <div aria-live="polite" class="notice page-column">
    <Message v-if="notice" severity="info">{{ notice.message }}</Message>
  </div>
  <main class="page-column">
    <RouterView />
  </main>
</template>
