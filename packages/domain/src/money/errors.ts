export type SplitErrorCode =
  | 'EMPTY_ORDER'
  | 'INVALID_QUANTITY'
  | 'INVALID_AMOUNT'
  | 'PRICE_BELOW_MINIMUM'
  | 'UNSAFE_AMOUNT'

export class SplitValidationError extends Error {
  override readonly name = 'SplitValidationError'
  readonly code: SplitErrorCode
  readonly lineIndex?: number

  constructor(code: SplitErrorCode, lineIndex?: number) {
    const where = lineIndex === undefined ? '' : ` on line ${lineIndex}`
    super(`Invalid order split: ${code}${where}`)
    this.code = code
    if (lineIndex !== undefined) {
      this.lineIndex = lineIndex
    }
  }
}

export class LedgerImbalanceError extends Error {
  override readonly name = 'LedgerImbalanceError'
  readonly expectedCents: number
  readonly actualCents: number

  constructor(expectedCents: number, actualCents: number) {
    super(
      `Ledger amounts total ${actualCents} cents but must total ${expectedCents} cents`,
    )
    this.expectedCents = expectedCents
    this.actualCents = actualCents
  }
}
