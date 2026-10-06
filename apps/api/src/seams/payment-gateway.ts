import { randomUUID } from 'node:crypto'

export interface ChargeRequest {
  amountCents: number
  /**
   * One key per (order, revision) quote. A real gateway must not charge twice for
   * it, and must refuse it for a different amount.
   */
  idempotencyKey: string
  description: string
}

export type ChargeFailureCode = 'DECLINED' | 'IDEMPOTENCY_KEY_REUSED'

export type ChargeResult =
  | {
      status: 'succeeded'
      reference: string
      /** What was actually charged; the API checks it against the expected total. */
      amountCents: number
    }
  | {
      status: 'failed'
      failureCode: ChargeFailureCode
      /** Safe to show to the payer. */
      failureMessage: string
    }

export interface ChargeOptions {
  /** Force a decline to exercise the failure path. Honored by the fake only. */
  simulateFailure?: boolean
}

export interface PaymentGateway {
  charge(request: ChargeRequest, options?: ChargeOptions): Promise<ChargeResult>
}

interface BoundCharge {
  amountCents: number
  result: ChargeResult
}

/**
 * In-process stand-in for a card processor. Succeeds unless failure is forced.
 * Each idempotency key is bound to the amount of its first successful charge: the
 * same key and amount replays that result, and the same key with a different
 * amount fails with IDEMPOTENCY_KEY_REUSED. Declines are not bound, so a declined
 * key can be retried.
 */
export class FakePaymentGateway implements PaymentGateway {
  /** Forces every charge to fail while true (for tests and demos). */
  failNextCharges = false
  readonly charges: ChargeRequest[] = []
  private readonly byKey = new Map<string, BoundCharge>()

  /** Forget every charge and key binding (test resets reuse order ids). */
  reset() {
    this.failNextCharges = false
    this.charges.length = 0
    this.byKey.clear()
  }

  async charge(
    request: ChargeRequest,
    options: ChargeOptions = {},
  ): Promise<ChargeResult> {
    this.charges.push(request)
    const bound = this.byKey.get(request.idempotencyKey)
    if (bound && bound.amountCents !== request.amountCents) {
      return {
        status: 'failed',
        failureCode: 'IDEMPOTENCY_KEY_REUSED',
        failureMessage:
          'This payment key was already used for a different amount',
      }
    }
    if (bound) return bound.result
    if (this.failNextCharges || options.simulateFailure) {
      return {
        status: 'failed',
        failureCode: 'DECLINED',
        failureMessage: 'Card declined (simulated gateway failure)',
      }
    }
    const result: ChargeResult = {
      status: 'succeeded',
      reference: `fake_ch_${randomUUID()}`,
      amountCents: request.amountCents,
    }
    this.byKey.set(request.idempotencyKey, {
      amountCents: request.amountCents,
      result,
    })
    return result
  }
}
