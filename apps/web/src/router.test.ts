import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from './router'

async function resolve(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  return router.currentRoute.value
}

describe('draft order routes', () => {
  it('sends the legacy ?orderId= URL to the canonical draft URL', async () => {
    const route = await resolve('/patients/7/orders/new?orderId=42')

    expect(route.fullPath).toBe('/patients/7/orders/42')
  })

  it('does not leave the legacy URL in history', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/patients/7')
    await router.push('/patients/7/orders/new?orderId=42')
    router.back()
    await new Promise((resolveBack) => setTimeout(resolveBack, 10))

    expect(router.currentRoute.value.fullPath).toBe('/patients/7')
  })

  it('keeps /new as the new-order URL', async () => {
    const route = await resolve('/patients/7/orders/new')

    expect(route.params).toEqual({ patientId: '7', orderId: 'new' })
  })

  it('opens a saved draft at the builder URL', async () => {
    const route = await resolve('/patients/7/orders/42')

    expect(route.params).toEqual({ patientId: '7', orderId: '42' })
  })

  it('uses one route record for /new and /:orderId so the builder is not remounted', async () => {
    const created = await resolve('/patients/7/orders/new')
    const saved = await resolve('/patients/7/orders/42')

    expect(created.matched[0]?.path).toBe(saved.matched[0]?.path)
    expect(created.matched[0]?.path).toContain(':orderId')
  })
})
