import type {
  CreateOrderRequest,
  DashboardDto,
  ListOrdersQuery,
  ListQuery,
  OrderDetailDto,
  OrderLineInput,
  OrderSummaryDto,
  Page,
  PatientDto,
  PatientOrderDetailDto,
  PayOrderRequest,
  ProductDto,
  ProviderOrderDetailDto,
  ReplaceOrderLinesRequest,
  UserDto,
} from '@supplement-orders/domain'
import { PAGE_LIMIT_MAX } from '@supplement-orders/domain'
import { request } from './client'

// One typed function per endpoint in FRONTEND_DESIGN.md §7.

export function listUsers() {
  return request<UserDto[]>('GET', '/users')
}

function listQueryString(query: ListQuery) {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  return search ? `?${search}` : ''
}

export function searchProducts(query: ListQuery = {}) {
  return request<Page<ProductDto>>('GET', `/products${listQueryString(query)}`)
}

export function searchPatients(query: ListQuery = {}) {
  return request<Page<PatientDto>>('GET', `/patients${listQueryString(query)}`)
}

/**
 * Transitional: collects every page into one array so screens built before
 * pagination keep working. Replace with searchProducts/searchPatients.
 */
async function collectAll<T>(
  fetchPage: (query: ListQuery) => Promise<Page<T>>,
  offset = 0,
): Promise<T[]> {
  const page = await fetchPage({ offset, limit: PAGE_LIMIT_MAX })
  const next = offset + page.items.length
  if (page.items.length === 0 || next >= page.total) return page.items
  return [...page.items, ...(await collectAll(fetchPage, next))]
}

export function listProducts() {
  return collectAll(searchProducts)
}

export function listPatients() {
  return collectAll(searchPatients)
}

export function getPatient(patientId: number) {
  return request<PatientDto>('GET', `/patients/${patientId}`)
}

export function listOrders(query: ListOrdersQuery = {}) {
  const search =
    query.patientId === undefined ? '' : `?patientId=${query.patientId}`
  return request<OrderSummaryDto[]>('GET', `/orders${search}`)
}

export function createOrder(patientId: number) {
  const body: CreateOrderRequest = { patientId }
  return request<ProviderOrderDetailDto>('POST', '/orders', body)
}

export function replaceOrderLines(orderId: number, lines: OrderLineInput[]) {
  const body: ReplaceOrderLinesRequest = { lines }
  return request<ProviderOrderDetailDto>(
    'PUT',
    `/orders/${orderId}/lines`,
    body,
  )
}

export function sendOrder(orderId: number) {
  return request<ProviderOrderDetailDto>('POST', `/orders/${orderId}/send`)
}

export function getOrder(orderId: number) {
  return request<OrderDetailDto>('GET', `/orders/${orderId}`)
}

export function payOrder(orderId: number, options: PayOrderRequest = {}) {
  return request<PatientOrderDetailDto>(
    'POST',
    `/orders/${orderId}/pay`,
    options,
  )
}

export function getDashboard() {
  return request<DashboardDto>('GET', '/dashboard')
}
