import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import HomeView from './HomeView.vue'

describe('HomeView', () => {
  it('renders the placeholder heading', () => {
    render(HomeView)

    expect(
      screen.getByRole('heading', { name: 'Supplement orders' }),
    ).toBeTruthy()
    expect(screen.getByText(/@supplement-orders\/domain/)).toBeTruthy()
  })
})
