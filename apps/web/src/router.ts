import type { Role } from '@supplement-orders/domain'
import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'
import {
  clearNoticeUnlessOn,
  homePathFor,
  roleLabel,
  showNotice,
  useCurrentUser,
} from './user'
import DashboardView from './views/DashboardView.vue'
import LoginView from './views/LoginView.vue'
import MyOrdersView from './views/MyOrdersView.vue'
import OrderBuilderView from './views/OrderBuilderView.vue'
import PatientDetailView from './views/PatientDetailView.vue'
import PatientOrderView from './views/PatientOrderView.vue'
import PatientsView from './views/PatientsView.vue'
import ProviderOrderView from './views/ProviderOrderView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    persona?: Role
  }
}

const provider = { persona: 'provider' as const }
const patient = { persona: 'patient' as const }

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView },
  // `/` only ever redirects (see the guard); LoginView is a placeholder.
  { path: '/', name: 'home', component: LoginView },
  { path: '/patients', component: PatientsView, meta: provider },
  {
    path: '/patients/:patientId',
    component: PatientDetailView,
    meta: provider,
    props: true,
  },
  {
    path: '/patients/:patientId/orders/new',
    component: OrderBuilderView,
    meta: provider,
    // ?orderId= reopens an existing draft in the builder.
    props: (route) => ({
      patientId: route.params.patientId,
      orderId:
        typeof route.query.orderId === 'string'
          ? route.query.orderId
          : undefined,
    }),
  },
  {
    path: '/orders/:orderId',
    component: ProviderOrderView,
    meta: provider,
    props: true,
  },
  { path: '/dashboard', component: DashboardView, meta: provider },
  { path: '/my-orders', component: MyOrdersView, meta: patient },
  {
    path: '/my-orders/:orderId',
    component: PatientOrderView,
    meta: patient,
    props: true,
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

/** Builds the router with the stub-auth and persona guards. */
export function createAppRouter(history: RouterHistory) {
  const router = createRouter({ history, routes })

  // Persona redirects are a convenience, not security: the API enforces access.
  router.beforeEach(async (to) => {
    const { ensureUsersLoaded, currentUser } = useCurrentUser()
    await ensureUsersLoaded()
    const user = currentUser.value

    if (!user) return to.name === 'login' ? true : { name: 'login' }
    if (to.name === 'login' || to.name === 'home') {
      return homePathFor(user.role)
    }

    const persona = to.meta.persona
    if (!persona || user.role === persona) return true

    const home = homePathFor(user.role)
    showNotice(
      `That page is for ${roleLabel(persona).toLowerCase()}s, so you were sent to your home page.`,
      home,
    )
    return home
  })

  router.afterEach((to) => clearNoticeUnlessOn(to.path))
  return router
}

export const router = createAppRouter(createWebHistory())
