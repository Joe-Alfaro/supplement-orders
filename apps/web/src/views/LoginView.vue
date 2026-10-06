<script setup lang="ts">
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ErrorBanner } from '../components'
import { homePathFor, useCurrentUser, userOptions } from '../user'

const router = useRouter()
const { users, loadError, ensureUsersLoaded, signIn } = useCurrentUser()
const selectedId = ref<number | null>(null)

const options = computed(() => userOptions(users.value))

/**
 * Accessibility fixes for PrimeVue's Select overlay, found by axe in a real
 * browser with the list open: its focus-wrap sentinels are aria-hidden yet
 * tabbable, and the scrolling list has nothing focusable. Tab already closes
 * the list through Select's own key handling, so the sentinels need not be tab
 * stops; the list container becomes keyboard-scrollable.
 */
const selectPt = {
  hiddenFirstFocusableEl: { tabindex: -1 },
  hiddenLastFocusableEl: { tabindex: -1 },
  listContainer: { tabindex: 0 },
}

async function submit() {
  const user = users.value.find(
    (candidate) => candidate.id === selectedId.value,
  )
  if (!user) return
  signIn(user.id)
  await router.push(homePathFor(user.role))
}
</script>

<template>
  <section class="login" aria-labelledby="login-heading">
    <h1 id="login-heading">Sign in</h1>
    <Message severity="info" :closable="false">
      Authentication is stubbed for this demo: choose a user to continue.
    </Message>
    <ErrorBanner
      v-if="loadError"
      :message="`Could not load users: ${loadError}`"
      retryable
      @retry="ensureUsersLoaded"
    />
    <form class="login-form" @submit.prevent="submit">
      <div class="field">
        <label id="login-user-label" for="login-user">User</label>
        <Select
          v-model="selectedId"
          input-id="login-user"
          aria-labelledby="login-user-label"
          :options="options"
          option-label="label"
          option-value="id"
          placeholder="Choose a user…"
          filter
          filter-placeholder="Search users"
          append-to="self"
          :pt="selectPt"
          fluid
        />
      </div>
      <Button type="submit" label="Sign in" :disabled="selectedId === null" />
    </form>
  </section>
</template>
