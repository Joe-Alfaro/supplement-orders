import { describe, expect, it } from 'vitest'
import { SplitValidationError, type SplitErrorCode } from './errors'
import { minUnitPriceCents } from './split'

// Revision 5: net markup on wholesale cost, uncapped. Replaces margin conversions.
// markupBpsFromPrice(c, p) = roundHalfUp((9925 * p - 10000 * c) / c), or null when c is 0.
// priceFromMarkupBps(c, k) = max(roundHalfUp(c * (10000 + k) / 9925), minUnitPriceCents(c)).
// Half up is toward +infinity: 4887.5 becomes 4888, and -5037.5 becomes -5037.
// k is an integer >= 0. These throws are SplitValidationError with no line index.
// markup.ts does not exist yet. A non-literal specifier keeps typecheck green;
// a missing module fails when the file loads.

interface MarkupConversions {
  markupBpsFromPrice: (
    unitCogsCents: number,
    unitPriceCents: number,
  ) => number | null
  priceFromMarkupBps: (unitCogsCents: number, markupBps: number) => number
}

interface MarkupFromPriceCase {
  unitCogsCents: number
  unitPriceCents: number
  markupBps: number | null
}

interface PriceFromMarkupCase {
  unitCogsCents: number
  markupBps: number
  unitPriceCents: number
}

interface RejectedPriceCase {
  label: string
  unitCogsCents: number
  unitPriceCents: number
}

interface RejectedMarkupCase {
  label: string
  unitCogsCents: number
  markupBps: number
}

interface UnsafePriceCase {
  label: string
  unitCogsCents: number
  markupBps: number
}

interface UnsafeMarkupCase {
  label: string
  unitCogsCents: number
  unitPriceCents: number
}

const markupSpecifier: string = './markup'

function readMarkup(loaded: unknown): MarkupConversions {
  if (typeof loaded !== 'object' || loaded === null) {
    throw new Error('markup conversions are not exported from ./markup')
  }
  const markupBpsFromPrice: unknown = Reflect.get(loaded, 'markupBpsFromPrice')
  const priceFromMarkupBps: unknown = Reflect.get(loaded, 'priceFromMarkupBps')
  if (
    typeof markupBpsFromPrice !== 'function' ||
    typeof priceFromMarkupBps !== 'function'
  ) {
    throw new Error('markup conversions are not exported from ./markup')
  }
  const conversions: MarkupConversions = {
    markupBpsFromPrice:
      markupBpsFromPrice as MarkupConversions['markupBpsFromPrice'],
    priceFromMarkupBps:
      priceFromMarkupBps as MarkupConversions['priceFromMarkupBps'],
  }
  return conversions
}

const markup = readMarkup(await import(markupSpecifier))
const { markupBpsFromPrice, priceFromMarkupBps } = markup

const MARKUP_FROM_PRICE: MarkupFromPriceCase[] = [
  { unitCogsCents: 1000, unitPriceCents: 4030, markupBps: 29998 },
  { unitCogsCents: 1275, unitPriceCents: 1927, markupBps: 5000 },
  { unitCogsCents: 850, unitPriceCents: 857, markupBps: 7 },
  { unitCogsCents: 1000, unitPriceCents: 4000, markupBps: 29700 },
  { unitCogsCents: 1000, unitPriceCents: 1000, markupBps: -75 },
  { unitCogsCents: 600, unitPriceCents: 1000, markupBps: 6542 },
  { unitCogsCents: 1275, unitPriceCents: 2450, markupBps: 9072 },
  { unitCogsCents: 33, unitPriceCents: 32, markupBps: -376 },
  { unitCogsCents: 0, unitPriceCents: 500, markupBps: null },
  { unitCogsCents: 2, unitPriceCents: 1, markupBps: -5037 },
  { unitCogsCents: 2, unitPriceCents: 3, markupBps: 4888 },
  {
    unitCogsCents: 1,
    unitPriceCents: 907_526_373_274,
    markupBps: 9_007_199_254_734_450,
  },
  {
    unitCogsCents: Number.MAX_SAFE_INTEGER,
    unitPriceCents: Number.MAX_SAFE_INTEGER,
    markupBps: -75,
  },
]

const PRICE_FROM_MARKUP: PriceFromMarkupCase[] = [
  { unitCogsCents: 1000, markupBps: 30000, unitPriceCents: 4030 },
  { unitCogsCents: 1275, markupBps: 5000, unitPriceCents: 1927 },
  { unitCogsCents: 850, markupBps: 0, unitPriceCents: 857 },
  { unitCogsCents: 670, markupBps: 10000, unitPriceCents: 1350 },
  { unitCogsCents: 1000, markupBps: 0, unitPriceCents: 1008 },
  { unitCogsCents: 2199, markupBps: 2500, unitPriceCents: 2770 },
  { unitCogsCents: 0, markupBps: 0, unitPriceCents: 0 },
  { unitCogsCents: 0, markupBps: 100_000, unitPriceCents: 0 },
  { unitCogsCents: 1000, markupBps: 100_000, unitPriceCents: 11083 },
  { unitCogsCents: 1000, markupBps: 1_000_000, unitPriceCents: 101_763 },
  { unitCogsCents: 1, markupBps: 100_000, unitPriceCents: 11 },
  {
    unitCogsCents: 1_000_000_000_000,
    markupBps: 100_000,
    unitPriceCents: 11_083_123_425_693,
  },
]

const REJECTED_PRICE: RejectedPriceCase[] = [
  { label: 'negative cost', unitCogsCents: -1, unitPriceCents: 100 },
  { label: 'fractional cost', unitCogsCents: 1.5, unitPriceCents: 100 },
  { label: 'NaN cost', unitCogsCents: Number.NaN, unitPriceCents: 100 },
  {
    label: 'infinite cost',
    unitCogsCents: Number.POSITIVE_INFINITY,
    unitPriceCents: 100,
  },
  { label: 'negative price', unitCogsCents: 100, unitPriceCents: -1 },
  {
    label: 'negative price at zero cost',
    unitCogsCents: 0,
    unitPriceCents: -1,
  },
  { label: 'fractional price', unitCogsCents: 100, unitPriceCents: 1.5 },
  { label: 'NaN price', unitCogsCents: 100, unitPriceCents: Number.NaN },
  {
    label: 'negative infinite price',
    unitCogsCents: 100,
    unitPriceCents: Number.NEGATIVE_INFINITY,
  },
]

const REJECTED_MARKUP: RejectedMarkupCase[] = [
  { label: 'negative cost', unitCogsCents: -1, markupBps: 0 },
  { label: 'fractional cost', unitCogsCents: 1.5, markupBps: 0 },
  { label: 'NaN cost', unitCogsCents: Number.NaN, markupBps: 0 },
  {
    label: 'infinite cost',
    unitCogsCents: Number.POSITIVE_INFINITY,
    markupBps: 0,
  },
  { label: 'markup of -1 bps', unitCogsCents: 100, markupBps: -1 },
  { label: 'negative markup at zero cost', unitCogsCents: 0, markupBps: -1 },
  { label: 'fractional markup', unitCogsCents: 100, markupBps: 1.5 },
  { label: 'NaN markup', unitCogsCents: 100, markupBps: Number.NaN },
  {
    label: 'infinite markup',
    unitCogsCents: 100,
    markupBps: Number.POSITIVE_INFINITY,
  },
]

const UNSAFE_PRICE: UnsafePriceCase[] = [
  {
    label: 'price above the safe integer range',
    unitCogsCents: 100_000_000_000_000,
    markupBps: 1_000_000,
  },
  {
    label: 'zero markup on the largest safe cost',
    unitCogsCents: Number.MAX_SAFE_INTEGER,
    markupBps: 0,
  },
  {
    label: 'markup above the safe integer range',
    unitCogsCents: 100,
    markupBps: 2 ** 53,
  },
]

const UNSAFE_MARKUP: UnsafeMarkupCase[] = [
  {
    label: 'markup bps above the safe integer range',
    unitCogsCents: 1,
    unitPriceCents: 1_000_000_000_000,
  },
  {
    label: 'markup bps one past the last safe result',
    unitCogsCents: 1,
    unitPriceCents: 907_526_373_275,
  },
]

// 0 through 4999, then samples past any old margin cap. Markup has no upper bound.
const SWEPT_MARKUPS = Array.from(
  { length: 5000 },
  (_unused, markupBps) => markupBps,
).concat([10_000, 30_000, 100_000, 1_000_000])

const SWEEP_COSTS = Array.from({ length: 81 }, (_unused, cost) => cost).concat([
  100, 670, 850, 1000, 1275, 1640, 2199, 2482, 7000,
])

const ZERO_MARKUP_COSTS = Array.from(
  { length: 1000 },
  (_unused, cost) => cost,
).concat([1640, 2199, 2482, 7000])

// Above the minimum, a round trip may miss by at most ceil(5000 / cost) + 1.
// A fixed 2 bps cap does not hold: one cent at cost 100 is about 99 bps.

function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (caught: unknown) {
    return caught
  }
  return undefined
}

function expectSplitCode(thrown: unknown, code: SplitErrorCode): void {
  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).toBeInstanceOf(SplitValidationError)
  if (!(thrown instanceof SplitValidationError)) {
    return
  }
  expect(thrown.name).toBe('SplitValidationError')
  expect(thrown.code).toBe(code)
  expect(thrown.lineIndex).toBeUndefined()
}

function priceBelowMinimum(costs: readonly number[]): string | undefined {
  return costs.reduce<string | undefined>((found, cost) => {
    if (found !== undefined) return found
    const minimum = minUnitPriceCents(cost)
    return SWEPT_MARKUPS.reduce<string | undefined>((hit, markupBps) => {
      if (hit !== undefined) return hit
      const unitPriceCents = priceFromMarkupBps(cost, markupBps)
      if (unitPriceCents < minimum) {
        return `cost ${cost} at ${markupBps} bps priced ${unitPriceCents}, minimum ${minimum}`
      }
      return undefined
    }, undefined)
  }, undefined)
}

function roundTripPastBound(costs: readonly number[]): string | undefined {
  return costs.reduce<string | undefined>((found, cost) => {
    if (found !== undefined || cost < 1) return found
    const minimum = minUnitPriceCents(cost)
    const bound = Math.ceil(5000 / cost) + 1
    return SWEPT_MARKUPS.reduce<string | undefined>((hit, markupBps) => {
      if (hit !== undefined) return hit
      const unitPriceCents = priceFromMarkupBps(cost, markupBps)
      if (unitPriceCents <= minimum) return undefined
      const recovered = markupBpsFromPrice(cost, unitPriceCents)
      if (recovered === null) {
        return `cost ${cost} at ${markupBps} bps priced ${unitPriceCents} and came back null`
      }
      const gap = Math.abs(recovered - markupBps)
      if (gap > bound) {
        return `cost ${cost} at ${markupBps} bps priced ${unitPriceCents} and came back ${recovered} (bound ${bound})`
      }
      return undefined
    }, undefined)
  }, undefined)
}

describe('markupBpsFromPrice', () => {
  it.each<MarkupFromPriceCase>(MARKUP_FROM_PRICE)(
    'cost $unitCogsCents at price $unitPriceCents is $markupBps bps',
    ({ unitCogsCents, unitPriceCents, markupBps }) => {
      expect(markupBpsFromPrice(unitCogsCents, unitPriceCents)).toBe(markupBps)
    },
  )

  it('returns null when the cost is 0', () => {
    expect(markupBpsFromPrice(0, 0)).toBeNull()
    expect(markupBpsFromPrice(0, 500)).toBeNull()
    expect(markupBpsFromPrice(0, 22_501)).toBeNull()
  })

  it.each<RejectedPriceCase>(REJECTED_PRICE)(
    'rejects $label',
    ({ unitCogsCents, unitPriceCents }) => {
      expectSplitCode(
        thrownBy(() => {
          markupBpsFromPrice(unitCogsCents, unitPriceCents)
        }),
        'INVALID_AMOUNT',
      )
    },
  )

  it.each<UnsafeMarkupCase>(UNSAFE_MARKUP)(
    'rejects $label',
    ({ unitCogsCents, unitPriceCents }) => {
      expectSplitCode(
        thrownBy(() => {
          markupBpsFromPrice(unitCogsCents, unitPriceCents)
        }),
        'UNSAFE_AMOUNT',
      )
    },
  )
})

describe('priceFromMarkupBps', () => {
  it.each<PriceFromMarkupCase>(PRICE_FROM_MARKUP)(
    'cost $unitCogsCents at $markupBps bps is price $unitPriceCents',
    ({ unitCogsCents, markupBps, unitPriceCents }) => {
      expect(priceFromMarkupBps(unitCogsCents, markupBps)).toBe(unitPriceCents)
    },
  )

  it('maps 0 bps to the minimum price', () => {
    ZERO_MARKUP_COSTS.forEach((cost) => {
      expect(priceFromMarkupBps(cost, 0)).toBe(minUnitPriceCents(cost))
    })
  })

  it('never prices below the minimum for a markup at or above 0', () => {
    expect(priceBelowMinimum(SWEEP_COSTS)).toBeUndefined()
  })

  it('accepts a markup with no upper bound', () => {
    expect(priceFromMarkupBps(1000, 100_000)).toBe(11_083)
    expect(priceFromMarkupBps(1, 100_000)).toBe(11)
  })

  it('stays within ceil(5000 / cost) + 1 bps above the minimum', () => {
    const price = priceFromMarkupBps(1000, 30_000)
    expect(price).toBe(4030)
    expect(price).toBeGreaterThan(minUnitPriceCents(1000))
    expect(markupBpsFromPrice(1000, price)).toBe(29_998)
    expect(roundTripPastBound(SWEEP_COSTS)).toBeUndefined()
  })

  it.each<RejectedMarkupCase>(REJECTED_MARKUP)(
    'rejects $label',
    ({ unitCogsCents, markupBps }) => {
      expectSplitCode(
        thrownBy(() => {
          priceFromMarkupBps(unitCogsCents, markupBps)
        }),
        'INVALID_AMOUNT',
      )
    },
  )

  it.each<UnsafePriceCase>(UNSAFE_PRICE)(
    'rejects $label',
    ({ unitCogsCents, markupBps }) => {
      expectSplitCode(
        thrownBy(() => {
          priceFromMarkupBps(unitCogsCents, markupBps)
        }),
        'UNSAFE_AMOUNT',
      )
    },
  )
})
