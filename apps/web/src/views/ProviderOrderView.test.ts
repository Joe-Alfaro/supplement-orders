import type { ProviderOrderDetailDto } from '@supplement-orders/domain'
import { screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import ProviderOrderView from './ProviderOrderView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getOrder: vi.fn() }
})

const paid: ProviderOrderDetailDto = {
  id: 42,
  view: 'provider',
  status: 'paid',
  patientId: 7,
  patientName: 'Jordan Lee',
  providerId: 1,
  providerName: 'Dr. Maya Rivera',
  createdAt: '2026-10-05T12:00:00.000Z',
  sentAt: '2026-10-05T12:05:00.000Z',
  paidAt: '2026-10-05T12:10:00.000Z',
  split: {
    subtotalCents: 12000,
    platformFeeCents: 90,
    totalCents: 12000,
    cogsCents: 7000,
    providerMarginCents: 4910,
  },
  patientDateOfBirth: '1984-03-14',
  patientAddress: '214 Alder St',
  lines: [
    {
      productId: 1,
      productName: 'Vitamin D3',
      sku: 'VITD',
      quantity: 3,
      unitPriceCents: 4000,
      lineTotalCents: 12000,
      unitCogsCents: 2333,
      marginBps: 4168,
      minUnitPriceCents: 2351,
      stockQuantity: 7,
    },
  ],
  payment: {
    id: 5,
    amountCents: 12000,
    reference: 'fake_ch_1',
    createdAt: '2026-10-05T12:10:00.000Z',
  },
  ledger: [
    {
      id: 1,
      type: 'cogs',
      amountCents: 7000,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
    {
      id: 2,
      type: 'provider_margin',
      amountCents: 4910,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
    {
      id: 3,
      type: 'platform_fee',
      amountCents: 90,
      createdAt: '2026-10-05T12:10:00.000Z',
    },
  ],
}

describe('ProviderOrderView', () => {
  it('labels the fee "Processing fee" in the split and ledger, and checks the total', async () => {
    vi.mocked(api.getOrder).mockResolvedValue(paid)
    await renderWithRouter(ProviderOrderView, {
      path: '/orders/42',
      props: { orderId: '42' },
    })
    await screen.findByText('Total of entries')

    expect(
      screen.getByRole('cell', { name: 'Processing fee' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Equals amount paid/)).toBeInTheDocument()
    expect(
      screen.getByRole('rowheader', { name: /^Processing fee \(0\.75%\)/ }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Platform fee/i)
  })
})
