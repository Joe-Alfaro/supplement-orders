import type { ApiRequestError } from './client'
import type { PatientOrderDetailDto, PayOrderRequest } from '@supplement-orders/domain'

// Revision 15 DTO additions, defined locally until the API worker's domain
// types are merged (DOMAIN_CONTRACT 15.1-15.3). Optional so older payloads
// and fixtures stay valid.

/** 15.1: the unresolved payment attempt that holds this order's stock. */
export interface UnresolvedAttemptDto {
  revision: number
  amountCents: number
}

export interface PayableLineDto {
  productId: number
  quantity: number
}

export interface PatientOrderRev15 {
  /** 15.3: the unpaid direct parent that must be paid first, or null. */
  blockedByOrderId?: number | null
  unresolvedAttempt?: UnresolvedAttemptDto | null
}

export type PatientOrder = PatientOrderDetailDto & PatientOrderRev15

/** 15.2: an `available` pay names the exact in-stock lines the patient saw. */
export type PayRequest = PayOrderRequest & {
  expectedPayableLines?: PayableLineDto[]
}

/** 15.3: 409 from pay while the direct parent is unpaid; `priorOrderId` in the body. */
export const PRIOR_ORDER_UNPAID =
  'PRIOR_ORDER_UNPAID' as ApiRequestError['code']
