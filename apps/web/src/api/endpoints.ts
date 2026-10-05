import type {
  CreateOrderRequest,
  DashboardDto,
  ListOrdersQuery,
  OrderDetailDto,
  OrderLineInput,
  OrderSummaryDto,
  PatientDto,
  PatientOrderDetailDto,
  PayOrderRequest,
  ProductDto,
  ProviderOrderDetailDto,
  ReplaceOrderLinesRequest,
  UserDto,
} from '@supplement-orders/domain'
import { request } from './client'

// One typed function per endpoint in FRONTEND_DESIGN.md §7.

export function listUsers() {
  return request<UserDto[]>('GET', '/users')
}

export function listProducts() {
  return request<ProductDto[]>('GET', '/products')
}

export function listPatients() {
  return request<PatientDto[]>('GET', '/patients')
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
