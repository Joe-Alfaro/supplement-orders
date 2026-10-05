import {
  parseDateOfBirthQuery,
  type ListQuery,
  type PatientDto,
  type PatientPageDto,
} from '@supplement-orders/domain'
import { fireEvent, screen } from '@testing-library/vue'
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
function patientPage(query: ListQuery): PatientPageDto {
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  if (query.q === 'nobody') return { items: [], total: 0, offset, limit }
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
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    expect(await screen.findByText('Showing 1–25 of 312')).toBeTruthy()

    const search = screen.getByLabelText('Search by name or date of birth')
    await fireEvent.update(search, 'l')
    await fireEvent.update(search, 'lee')

    await vi.waitFor(() =>
      expect(api.searchPatients).toHaveBeenLastCalledWith({
        q: 'lee',
        offset: 0,
        limit: 25,
      }),
    )
    expect(api.searchPatients).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'l' }),
    )
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query.q).toBe('lee'),
    )
    expect(await screen.findByText('lee 1')).toBeTruthy()
  })

  it('starts from q in the URL and pages with Previous/Next', async () => {
    await renderWithRouter(PatientsView, { path: '/patients?q=lee' })
    expect(await screen.findByDisplayValue('lee')).toBeTruthy()
    expect(api.searchPatients).toHaveBeenCalledWith({
      q: 'lee',
      offset: 0,
      limit: 25,
    })

    const previous = screen.getByRole('button', {
      name: 'Previous page of patients',
    })
    expect(previous).toHaveProperty('disabled', true)
    await fireEvent.click(
      screen.getByRole('button', { name: 'Next page of patients' }),
    )

    expect(await screen.findByText('Showing 26–50 of 312')).toBeTruthy()
    expect(api.searchPatients).toHaveBeenLastCalledWith({
      q: 'lee',
      offset: 25,
      limit: 25,
    })
    expect(previous).toHaveProperty('disabled', false)
  })

  it('shows a no-match message with Clear search', async () => {
    await renderWithRouter(PatientsView, { path: '/patients?q=nobody' })

    expect(await screen.findByText(/No patients match "nobody"/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(await screen.findByText('Showing 1–25 of 312')).toBeTruthy()
    expect(api.searchPatients).toHaveBeenLastCalledWith({
      q: '',
      offset: 0,
      limit: 25,
    })
  })

  it('opens a patient from anywhere on the row, or with Enter', async () => {
    const { router } = await renderWithRouter(PatientsView, {
      path: '/patients',
    })
    await fireEvent.click(await screen.findByText('01/04/1980'))
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients/3'),
    )

    const row = screen.getByText('Patient 5').closest('tr')
    if (!row) throw new Error('row not found')
    await fireEvent.keyDown(row, { key: 'Enter' })
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/patients/5'),
    )
  })

  it('shows DOB so same-name patients can be told apart', async () => {
    await renderWithRouter(PatientsView, { path: '/patients?q=Avery Abbott' })

    const rows = await screen.findAllByText('Avery Abbott')
    expect(rows).toHaveLength(2)
    expect(
      screen.getByRole('columnheader', { name: 'Date of birth' }),
    ).toBeTruthy()
    expect(screen.getByText('03/12/1984')).toBeTruthy()
    expect(screen.getByText('11/30/1991')).toBeTruthy()
  })

  it.each(['03/12/1984', '1984-03-12'])(
    'finds the patient by DOB typed as %s',
    async (dob) => {
      await renderWithRouter(PatientsView, { path: '/patients' })
      await screen.findByText('Showing 1–25 of 312')

      await fireEvent.update(
        screen.getByLabelText('Search by name or date of birth'),
        dob,
      )

      await vi.waitFor(() =>
        expect(api.searchPatients).toHaveBeenLastCalledWith({
          q: dob,
          offset: 0,
          limit: 25,
        }),
      )
      expect(await screen.findByText('Showing 1–1 of 1')).toBeTruthy()
      expect(screen.getByText('Avery Abbott')).toBeTruthy()
      expect(screen.getByText('03/12/1984')).toBeTruthy()
    },
  )
})
