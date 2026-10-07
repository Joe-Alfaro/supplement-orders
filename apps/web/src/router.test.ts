import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from './router'

async function resolve(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  return router.currentRoute.value
}

describe('draft order routes', () => {
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
