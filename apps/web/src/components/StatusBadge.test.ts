import { render, screen } from '@testing-library/vue'
import PrimeVue from 'primevue/config'
import { describe, expect, it } from 'vitest'
import { primeVueOptions } from '../primevue'
import type { UiOrderStatus } from '../stock'
import StatusBadge from './StatusBadge.vue'

function renderBadge(status: UiOrderStatus) {
  return render(StatusBadge, {
    props: { status },
    global: { plugins: [[PrimeVue, primeVueOptions]] },
  })
}

describe('StatusBadge', () => {
  it('shows "Awaiting stock", distinct from "Awaiting payment"', () => {
    renderBadge('awaiting_stock')
    const tag = screen.getByText('Awaiting stock')
    expect(tag).toBeInTheDocument()
    expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument()
    expect(tag.className).not.toContain('p-tag-warn')
  })

  it('keeps the existing labels', () => {
    renderBadge('pending_payment')
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
  })
})
