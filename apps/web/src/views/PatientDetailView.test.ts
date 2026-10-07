import type { ProviderOrderSummaryDto } from '@supplement-orders/domain'
import { screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import PatientDetailView from './PatientDetailView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getPatient: vi.fn(), listOrders: vi.fn() }
})

const draft: ProviderOrderSummaryDto = {
  id: 13,
  view: 'provider',
  status: 'draft',
  patientId: 7,
  patientName: 'Jordan Lee',
  createdAt: '2026-10-05T12:00:00.000Z',
  split: null,
} as ProviderOrderSummaryDto

beforeEach(() => {
  vi.mocked(api.getPatient).mockResolvedValue({
    id: 7,
    userId: 3,
    providerId: 1,
    name: 'Jordan Lee',
    dateOfBirth: '1984-03-14',
    address: '214 Alder St',
    orderCount: 1,
    latestOrderStatus: 'draft',
  })
  vi.mocked(api.listOrders).mockResolvedValue([draft])
})

describe('PatientDetailView', () => {
  it('opens a draft row in the builder at its canonical URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(PatientDetailView, {
      path: '/patients/7',
      props: { patientId: '7' },
    })

    await user.click(await screen.findByText('Incomplete draft'))

    expect(router.currentRoute.value.path).toBe('/patients/7/orders/13')
  })

  it('opens a non-draft row on the order detail page', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listOrders).mockResolvedValue([
      { ...draft, id: 14, status: 'pending_payment' },
    ])
    const { router } = await renderWithRouter(PatientDetailView, {
      path: '/patients/7',
      props: { patientId: '7' },
    })

    await user.click(await screen.findByText('Incomplete draft'))

    expect(router.currentRoute.value.path).toBe('/orders/14')
  })
})
