import type {
  AdminJournalPageDto,
  AdminProductDto,
  AdminTrialBalanceDto,
  AdminProductPageDto,
  CreateOrderRequest,
  IncrementStockRequest,
  SetStockRequest,
  DashboardDto,
  ListOrdersQuery,
  ListPatientsQuery,
  ProviderOrderListPageDto,
  ListQuery,
  OrderDetailDto,
  OrderLineInput,
  OrderStatus,
  OrderSummaryDto,
  PatientDto,
  PatientPageDto,
  PatientOrderDetailDto,
  PayOrderRequest,
  SendOrderRequest,
  ProductPageDto,
  ProviderOrderDetailDto,
  ReplaceOrderLinesRequest,
  SignInOptionDto,
  UserDto,
} from '@supplement-orders/domain'
import { readStoredUserId } from '../user/storage'
import { request } from './client'

// One typed function per endpoint in FRONTEND_DESIGN.md §7.

/**
 * Revision 17.1: there is no user directory. This returns the signed-in user
 * from GET /api/users/me as a one-item list, or none when nobody is signed in.
 */
export async function listUsers(): Promise<UserDto[]> {
  if (readStoredUserId() === null) return []
  return [await request<UserDto>('GET', '/users/me')]
}

/** The curated login list, already in display order: id, name and role only. */
export function listSignInOptions() {
  return request<SignInOptionDto[]>('GET', '/users/sign-in-options')
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

/** GET /api/admin/products (admin only): the catalog with editable stock. */
export function searchAdminProducts(query: ListQuery = {}) {
  return request<AdminProductPageDto>(
    'GET',
    `/admin/products${listQueryString(query)}`,
  )
}

/** POST .../stock/increment: an atomic add; returns the updated row. */
export function incrementProductStock(productId: number, by: number) {
  return request<AdminProductDto>(
    'POST',
    `/admin/products/${productId}/stock/increment`,
    { by } satisfies IncrementStockRequest,
  )
}

/** PUT .../stock: compare-and-set; 409 STOCK_CHANGED when `expected` is stale. */
export function setProductStock(productId: number, body: SetStockRequest) {
  return request<AdminProductDto>(
    'PUT',
    `/admin/products/${productId}/stock`,
    body,
  )
}

export function searchPatients(query: ListPatientsQuery = {}) {
  const search = listQueryString(query)
  const filter = query.latestStatus
    ? `${search ? '&' : '?'}latestStatus=${query.latestStatus}`
    : ''
  return request<PatientPageDto>('GET', `/patients${search}${filter}`)
}

/**
 * GET /api/orders?status= (provider): one page of orders whose status is any of
 * `statuses` (sent as a comma list). An empty list means every status (`all`).
 */
export function listProviderOrders(
  query: { statuses: readonly OrderStatus[] } & Pick<
    ListOrdersQuery,
    'offset' | 'limit'
  >,
) {
  const status = query.statuses.length ? query.statuses.join(',') : 'all'
  const search = listQueryString(query)
  const params = search ? `&${search.slice(1)}` : ''
  return request<ProviderOrderListPageDto>(
    'GET',
    `/orders?status=${status}${params}`,
  )
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

/** `acknowledgeLowStock` confirms a send with lines over stock (revision 14). */
export function sendOrder(orderId: number, body?: SendOrderRequest) {
  return request<ProviderOrderDetailDto>(
    'POST',
    `/orders/${orderId}/send`,
    body,
  )
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

/**
 * Pay the quote the patient saw (revision 9): `expectedRevision` and
 * `expectedTotalCents` come from the displayed order. If it changed since, the
 * server answers 409 ORDER_CHANGED and charges nothing.
 */
export function payOrder(orderId: number, body: PayOrderRequest) {
  return request<PatientOrderDetailDto>('POST', `/orders/${orderId}/pay`, body)
}

/** Dashboard window, passed through to the server, which resolves the days. */
export interface DashboardParams {
  /** month (default when omitted), last30, all or custom. */
  range?: string
  /** Inclusive local day `YYYY-MM-DD`; custom only. */
  from?: string
  to?: string
  /** IANA zone the server uses to find "today" and day boundaries. */
  tz?: string
}

export function getDashboard(params: DashboardParams = {}) {
  const search = new URLSearchParams()
  const keys = ['range', 'from', 'to', 'tz'] as const
  keys.forEach((key) => {
    const value = params[key]
    if (value) search.set(key, value)
  })
  const query = search.toString()
  return request<DashboardDto>('GET', `/dashboard${query ? `?${query}` : ''}`)
}

/** GET /api/admin/accounts (admin only): the trial balance. */
export function getAdminAccounts() {
  return request<AdminTrialBalanceDto>('GET', '/admin/accounts')
}

/** GET /api/admin/journals (admin only): newest first, with postings. */
export function listAdminJournals(query: ListQuery = {}) {
  const params = new URLSearchParams()
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  return request<AdminJournalPageDto>(
    'GET',
    `/admin/journals${search ? `?${search}` : ''}`,
  )
}
