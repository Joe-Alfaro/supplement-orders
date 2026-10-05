import { describe, expect, it } from 'vitest'
import { SplitValidationError } from './errors'

// Revision 2 conversions. ./margin is not in the revision 1 tree, so the
// module is loaded by a non-literal specifier. That keeps typecheck green
// until the file exists, and a missing module fails these tests.
// Half up is toward +infinity: 9687.5 becomes 9688, and -1250.5 becomes -1250.
// These throws are SplitValidationError with no line index. The functions are
// not line-scoped.

interface BpsFromPrice {
  (unitCogsCents: number, unitPriceCents: number): number
}

interface PriceFromBps {
  (unitCogsCents: number, marginBps: number): number
}

interface MarginModule {
  marginBpsFromPrice: BpsFromPrice
  priceFromMarginBps: PriceFromBps
}

interface MarginHolder {
  margin?: MarginModule
  pending?: Promise<MarginModule>
}

interface MarginFromPriceCase {
  unitCogsCents: number
  unitPriceCents: number
  marginBps: number
}

interface PriceFromMarginCase {
  unitCogsCents: number
  marginBps: number
  unitPriceCents: number
}

interface RejectedPriceCase {
  label: string
  unitCogsCents: number
  unitPriceCents: number
}

interface RejectedBpsCase {
  label: string
  unitCogsCents: number
  marginBps: number
}

const MARGIN_FROM_PRICE: MarginFromPriceCase[] = [
  { unitCogsCents: 1275, unitPriceCents: 2450, marginBps: 4796 },
  { unitCogsCents: 1275, unitPriceCents: 2125, marginBps: 4000 },
  { unitCogsCents: 1000, unitPriceCents: 1000, marginBps: 0 },
  { unitCogsCents: 0, unitPriceCents: 500, marginBps: 10000 },
  { unitCogsCents: 0, unitPriceCents: 0, marginBps: 0 },
  { unitCogsCents: 500, unitPriceCents: 0, marginBps: 0 },
  { unitCogsCents: 22501, unitPriceCents: 20000, marginBps: -1250 },
  { unitCogsCents: 1, unitPriceCents: 32, marginBps: 9688 },
  { unitCogsCents: 33, unitPriceCents: 32, marginBps: -312 },
  { unitCogsCents: 1, unitPriceCents: 3, marginBps: 6667 },
  { unitCogsCents: 2, unitPriceCents: 3, marginBps: 3333 },
  { unitCogsCents: 4, unitPriceCents: 3, marginBps: -3333 },
  { unitCogsCents: 5, unitPriceCents: 3, marginBps: -6667 },
]

const PRICE_FROM_MARGIN: PriceFromMarginCase[] = [
  { unitCogsCents: 1275, marginBps: 4796, unitPriceCents: 2450 },
  { unitCogsCents: 1275, marginBps: 4000, unitPriceCents: 2125 },
  { unitCogsCents: 0, marginBps: 0, unitPriceCents: 0 },
  { unitCogsCents: 1275, marginBps: 0, unitPriceCents: 1275 },
  { unitCogsCents: 1275, marginBps: 5000, unitPriceCents: 2550 },
  { unitCogsCents: 1, marginBps: 9999, unitPriceCents: 10000 },
  { unitCogsCents: 1, marginBps: 9968, unitPriceCents: 313 },
  { unitCogsCents: 1, marginBps: 9997, unitPriceCents: 3333 },
  { unitCogsCents: 2, marginBps: 9997, unitPriceCents: 6667 },
  { unitCogsCents: 3, marginBps: 9999, unitPriceCents: 30000 },
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
  { label: 'fractional price', unitCogsCents: 100, unitPriceCents: 1.5 },
  { label: 'NaN price', unitCogsCents: 100, unitPriceCents: Number.NaN },
  {
    label: 'negative infinite price',
    unitCogsCents: 100,
    unitPriceCents: Number.NEGATIVE_INFINITY,
  },
]

const REJECTED_BPS: RejectedBpsCase[] = [
  { label: 'negative cost', unitCogsCents: -1, marginBps: 0 },
  { label: 'fractional cost', unitCogsCents: 1.5, marginBps: 0 },
  { label: 'NaN cost', unitCogsCents: Number.NaN, marginBps: 0 },
  {
    label: 'infinite cost',
    unitCogsCents: Number.POSITIVE_INFINITY,
    marginBps: 0,
  },
  { label: 'negative margin', unitCogsCents: 100, marginBps: -1 },
  { label: 'margin of 10000 bps', unitCogsCents: 100, marginBps: 10000 },
  { label: 'margin above 10000 bps', unitCogsCents: 100, marginBps: 10001 },
  { label: 'fractional margin', unitCogsCents: 100, marginBps: 1.5 },
  { label: 'NaN margin', unitCogsCents: 100, marginBps: Number.NaN },
  {
    label: 'infinite margin',
    unitCogsCents: 100,
    marginBps: Number.POSITIVE_INFINITY,
  },
]

const holder: MarginHolder = {}

async function marginModule(): Promise<MarginModule> {
  if (holder.margin) {
    return holder.margin
  }
  if (!holder.pending) {
    holder.pending = loadMargin().then((loaded) => {
      holder.margin = loaded
      return loaded
    })
  }
  return holder.pending
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asFunction<T>(value: unknown, name: string): T {
  if (typeof value !== 'function') {
    throw new Error(`${name} is not exported from ./margin`)
  }
  return value as T
}

async function loadMargin(): Promise<MarginModule> {
  const specifier: string = './margin'
  const loaded: unknown = await import(specifier)
  if (!isRecord(loaded)) {
    throw new Error('margin module did not load')
  }
  return {
    marginBpsFromPrice: asFunction<BpsFromPrice>(
      loaded.marginBpsFromPrice,
      'marginBpsFromPrice',
    ),
    priceFromMarginBps: asFunction<PriceFromBps>(
      loaded.priceFromMarginBps,
      'priceFromMarginBps',
    ),
  }
}

function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (caught: unknown) {
    return caught
  }
  return undefined
}

function expectInvalidAmount(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).toBeInstanceOf(SplitValidationError)
  if (!(thrown instanceof SplitValidationError)) {
    return
  }
  expect(thrown.name).toBe('SplitValidationError')
  expect(thrown.code).toBe('INVALID_AMOUNT')
  expect(thrown.lineIndex).toBeUndefined()
}

describe('marginBpsFromPrice', () => {
  it.each<MarginFromPriceCase>(MARGIN_FROM_PRICE)(
    'cost $unitCogsCents at price $unitPriceCents is $marginBps bps',
    async ({ unitCogsCents, unitPriceCents, marginBps }) => {
      const margin = await marginModule()
      expect(margin.marginBpsFromPrice(unitCogsCents, unitPriceCents)).toBe(
        marginBps,
      )
    },
  )

  it('returns 0 when the price is 0, including when cost is positive', async () => {
    const margin = await marginModule()
    expect(margin.marginBpsFromPrice(0, 0)).toBe(0)
    expect(margin.marginBpsFromPrice(22501, 0)).toBe(0)
  })

  it.each<RejectedPriceCase>(REJECTED_PRICE)(
    'rejects $label',
    async ({ unitCogsCents, unitPriceCents }) => {
      const margin = await marginModule()
      expectInvalidAmount(
        thrownBy(() => {
          margin.marginBpsFromPrice(unitCogsCents, unitPriceCents)
        }),
      )
    },
  )
})

describe('priceFromMarginBps', () => {
  it.each<PriceFromMarginCase>(PRICE_FROM_MARGIN)(
    'cost $unitCogsCents at $marginBps bps is price $unitPriceCents',
    async ({ unitCogsCents, marginBps, unitPriceCents }) => {
      const margin = await marginModule()
      expect(margin.priceFromMarginBps(unitCogsCents, marginBps)).toBe(
        unitPriceCents,
      )
    },
  )

  it('accepts a margin of 0 bps and returns the cost', async () => {
    const margin = await marginModule()
    expect(margin.priceFromMarginBps(66, 0)).toBe(66)
    expect(margin.priceFromMarginBps(0, 5000)).toBe(0)
  })

  it('can price below the minimum, which callers still have to reject', async () => {
    // m = 0 returns cost. Cost 66 is below minUnitPriceCents(66), which is 67.
    const margin = await marginModule()
    expect(margin.priceFromMarginBps(66, 0)).toBe(66)
    expect(margin.priceFromMarginBps(1275, 0)).toBe(1275)
  })

  it('does not promise that converting back restores the margin', async () => {
    const margin = await marginModule()
    const price = margin.priceFromMarginBps(1275, 1)
    expect(price).toBe(1275)
    expect(margin.marginBpsFromPrice(1275, price)).toBe(0)
  })

  it.each<RejectedBpsCase>(REJECTED_BPS)(
    'rejects $label',
    async ({ unitCogsCents, marginBps }) => {
      const margin = await marginModule()
      expectInvalidAmount(
        thrownBy(() => {
          margin.priceFromMarginBps(unitCogsCents, marginBps)
        }),
      )
    },
  )
})
