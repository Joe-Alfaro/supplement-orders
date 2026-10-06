// The web app never reimplements money math: everything comes from the shared domain package
// so the client preview and the server agree to the cent.
export {
  computePlatformFee,
  computeSplit,
  formatCents,
  marginBpsFromPrice,
  minUnitPriceCents,
  parseDollarsToCents,
  PLATFORM_FEE_BPS,
  priceFromMarginBps,
  SplitValidationError,
} from '@supplement-orders/domain'
export type { OrderSplit, ParseResult, SplitLine } from '@supplement-orders/domain'
export { formatBps, parsePercentToBps } from './percent'
export type { PercentParseResult } from './percent'
