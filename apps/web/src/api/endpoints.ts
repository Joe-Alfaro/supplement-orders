import type {
  CreateOrderRequest,
  DashboardDto,
  ListOrdersQuery,
  ListQuery,
  OrderDetailDto,
  OrderLineInput,
  OrderSummaryDto,
  PatientDto,
  PatientPageDto,
  PatientOrderDetailDto,
  PayOrderRequest,
  ProductPageDto,
  ProviderOrderDetailDto,
  ReplaceOrderLinesRequest,
  UserDto,
} from '@supplement-orders/domain'
import { request } from './client'

// One typed function per endpoint in FRONTEND_DESIGN.md §7.

export function listUsers() {
  return request<UserDto[]>('GET', '/users')
}

/** Query string for a paged list; empty values are omitted. */
function listQueryString(query: ListQuery) {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  return search ? `?${search}` : ''
}

export function searchProducts(query: ListQuery = {}) {
  return request<ProductPageDto>('GET', `/products${listQueryString(query)}`)
}

export function searchPatients(query: ListQuery = {}) {
  return request<PatientPageDto>('GET', `/patients${listQueryString(query)}`)
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
