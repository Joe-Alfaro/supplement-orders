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
  ProviderOrderListPageDto,
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

/** The provider's pending_payment orders, one page, oldest sent first. */
export function listAwaitingPayment(
  query: Pick<ListOrdersQuery, 'offset' | 'limit'> = {},
) {
  const search = listQueryString(query)
  const params = search ? `&${search.slice(1)}` : ''
  return request<ProviderOrderListPageDto>(
    'GET',
    `/orders?status=pending_payment${params}`,
  )
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

/** Draft or pending_payment only; 409 ORDER_NOT_CANCELLABLE otherwise. */
export function cancelOrder(orderId: number) {
  return request<ProviderOrderDetailDto>('POST', `/orders/${orderId}/cancel`)
}

/** Draft only, permanently (revision 8); 409 for any other status. */
export function deleteOrder(orderId: number) {
  return request<void>('DELETE', `/orders/${orderId}`)
}

/** Cancelled only: back to draft with its lines kept (revision 8); 409 otherwise. */
export function reopenOrder(orderId: number) {
  return request<ProviderOrderDetailDto>('POST', `/orders/${orderId}/reopen`)
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
