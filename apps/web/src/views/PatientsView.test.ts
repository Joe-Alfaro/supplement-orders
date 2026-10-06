import {
  parseDateOfBirthQuery,
  type ListPatientsQuery,
  type PatientDto,
  type PatientPageDto,
} from '@supplement-orders/domain'
import { screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { renderWithRouter } from '../test/renderWithRouter'
import PatientsView from './PatientsView.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, searchPatients: vi.fn() }
})

function patient(
  id: number,
  name: string,
  dateOfBirth = `1980-01-${String((id % 28) + 1).padStart(2, '0')}`,
): PatientDto {
  return {
    id,
    userId: id + 100,
    providerId: 1,
    name,
    dateOfBirth,
    address: `${id} Main St`,
    orderCount: 0,
    latestOrderStatus: null,
  }
}

/** A fake GET /api/patients with 312 patients in total. */
function patientPage(query: ListPatientsQuery): PatientPageDto {
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  if (query.q === 'nobody' || query.latestStatus === 'cancelled') {
    return { items: [], total: 0, offset, limit }
  }
  const twins = [
    patient(901, 'Avery Abbott', '1984-03-12'),
    patient(902, 'Avery Abbott', '1991-11-30'),
  ]
  if (query.q === 'Avery Abbott') {
    return { items: twins, total: 2, offset, limit }
  }
  // Like the API: a whole-query date matches the exact date of birth.
  const dob = query.q ? parseDateOfBirthQuery(query.q) : null
  if (dob) {
    const items = twins.filter((p) => p.dateOfBirth === dob)
    return { items, total: items.length, offset, limit }
  }
  const items = Array.from({ length: limit }, (_, i) =>
    patient(offset + i + 1, `${query.q || 'Patient'} ${offset + i + 1}`),
  )
  return { items, total: 312, offset, limit }
}

beforeEach(() => {
  vi.mocked(api.searchPatients)
    .mockReset()
    .mockImplementation(async (query = {}) => patientPage(query))
})

describe('PatientsView', () => {
  it('searches on the server (debounced) and keeps q in the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    expect(await screen.findByText('Showing 1–25 of 312')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Patients' })).toBeInTheDocument()

    await user.type(
      screen.getByRole('searchbox', {
        name: 'Search by name or date of birth',
      }),
      'lee',
    )

    await vi.waitFor(() =>
      expect(api.searchPatients).toHaveBeenLastCalledWith({
        q: 'lee',
        offset: 0,
        limit: 25,
      }),
    )
    // Only the settled query went out, not each keystroke.
    expect(api.searchPatients).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'l' }),
    )
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query.q).toBe('lee'),
    )
    expect(await screen.findByText('lee 1')).toBeInTheDocument()
  })

  it('starts from q in the URL and pages with Previous/Next', async () => {
    const user = userEvent.setup()
    await renderWithRouter(PatientsView, { path: '/patients?q=lee' })
    expect(
      await screen.findByRole('searchbox', {
        name: 'Search by name or date of birth',
      }),
    ).toHaveValue('lee')
    expect(api.searchPatients).toHaveBeenCalledWith({
      q: 'lee',
      offset: 0,
      limit: 25,
    })

    const previous = await screen.findByRole('button', {
      name: 'Previous Page',
    })
    expect(previous).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next Page' }))

    expect(await screen.findByText('Showing 26–50 of 312')).toBeInTheDocument()
    expect(api.searchPatients).toHaveBeenLastCalledWith({
      q: 'lee',
      offset: 25,
      limit: 25,
    })
    expect(screen.getByRole('button', { name: 'Previous Page' })).toBeEnabled()
  })

  it('shows a no-match message with Clear search', async () => {
    const user = userEvent.setup()
    await renderWithRouter(PatientsView, { path: '/patients?q=nobody' })

    expect(
      await screen.findByText(/No patients match "nobody"/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(await screen.findByText('Showing 1–25 of 312')).toBeInTheDocument()
    expect(api.searchPatients).toHaveBeenLastCalledWith({
      q: '',
      offset: 0,
      limit: 25,
    })
  })

  it('opens a patient from anywhere on the row, or with Enter', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    await user.click(await screen.findByText('01/04/1980'))
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients/3'),
    )

    screen.getByRole('row', { name: /Patient 5/ }).focus()
    await user.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients/5'),
    )
  })

  it('shows DOB so same-name patients can be told apart', async () => {
    await renderWithRouter(PatientsView, { path: '/patients?q=Avery Abbott' })

    expect(await screen.findAllByText('Avery Abbott')).toHaveLength(2)
    expect(
      screen.getByRole('columnheader', { name: 'Date of birth' }),
    ).toBeInTheDocument()
    expect(screen.getByText('03/12/1984')).toBeInTheDocument()
    expect(screen.getByText('11/30/1991')).toBeInTheDocument()
  })

  it.each(['03/12/1984', '1984-03-12'])(
    'finds the patient by DOB typed as %s',
    async (dob) => {
      const user = userEvent.setup()
      await renderWithRouter(PatientsView, { path: '/patients' })
      await screen.findByText('Showing 1–25 of 312')

      await user.type(
        screen.getByRole('searchbox', {
          name: 'Search by name or date of birth',
        }),
        dob,
      )

      await vi.waitFor(() =>
        expect(api.searchPatients).toHaveBeenLastCalledWith({
          q: dob,
          offset: 0,
          limit: 25,
        }),
      )
      expect(await screen.findByText('Showing 1–1 of 1')).toBeInTheDocument()
      expect(screen.getByText('Avery Abbott')).toBeInTheDocument()
      expect(screen.getByText('03/12/1984')).toBeInTheDocument()
    },
  )

  it('filters by latest order status on the server and keeps it in the URL', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients?q=lee',
    })
    await screen.findByText('Showing 1–25 of 312')

    const filter = screen.getByRole('combobox', { name: 'Latest order status' })
    expect(filter).toHaveTextContent('Any')
    await user.click(filter)
    await user.click(await screen.findByRole('option', { name: 'Paid' }))

    // Combined with the search, back on the first page.
    await vi.waitFor(() =>
      expect(api.searchPatients).toHaveBeenLastCalledWith({
        q: 'lee',
        offset: 0,
        limit: 25,
        latestStatus: 'paid',
      }),
    )
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({
        q: 'lee',
        status: 'paid',
      }),
    )
  })

  it('starts from ?status= in the URL', async () => {
    await renderWithRouter(PatientsView, { path: '/patients?status=none' })

    expect(
      await screen.findByRole('combobox', { name: 'Latest order status' }),
    ).toHaveTextContent('No orders')
    expect(api.searchPatients).toHaveBeenCalledWith({
      q: '',
      offset: 0,
      limit: 25,
      latestStatus: 'none',
    })
  })

  it('shows a filter-specific empty state and clears filters', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients?status=cancelled',
    })

    expect(
      await screen.findByText('No patients whose latest order is cancelled.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect(await screen.findByText('Showing 1–25 of 312')).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Latest order status' }),
    ).toHaveTextContent('Any')
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}))
  })
})
