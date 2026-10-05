import { randomUUID } from 'node:crypto'

export interface ChargeRequest {
  amountCents: number
  /** Same key for the same order: a real gateway must not charge twice for it. */
  idempotencyKey: string
  description: string
}

export interface ChargeResult {
  reference: string
  status: 'succeeded' | 'failed'
  /** Present when status is failed; safe to show to the payer. */
  failureMessage?: string
}

export interface ChargeOptions {
  /** Force a decline to exercise the rollback path. Honored by the fake only. */
  simulateFailure?: boolean
}

export interface PaymentGateway {
  charge(request: ChargeRequest, options?: ChargeOptions): Promise<ChargeResult>
}

/**
 * In-process stand-in for a card processor. Succeeds unless failure is forced, and
 * replays the original result for a repeated idempotency key.
 */
export class FakePaymentGateway implements PaymentGateway {
  /** Forces every charge to fail while true (for tests and demos). */
  failNextCharges = false
  readonly charges: ChargeRequest[] = []
  private readonly byKey = new Map<string, ChargeResult>()

  async charge(request: ChargeRequest, options: ChargeOptions = {}) {
    this.charges.push(request)
    if (this.failNextCharges || options.simulateFailure) {
      return {
        reference: '',
        status: 'failed' as const,
        failureMessage: 'Card declined (simulated gateway failure)',
      }
    }
    const previous = this.byKey.get(request.idempotencyKey)
    if (previous) return previous
    const result: ChargeResult = {
      reference: `fake_ch_${randomUUID()}`,
      status: 'succeeded',
    }
    this.byKey.set(request.idempotencyKey, result)
    return result
  }
}
