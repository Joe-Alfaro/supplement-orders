import {
  adminJournalPageDtoSchema,
  adminTrialBalanceDtoSchema,
  computeSplit,
  type OrderSplit,
} from '@supplement-orders/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { as, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 16.4: the admin's read-only view of the double-entry ledger. Named
// seed: patient 3 (user 5, Alex Kim) belongs to provider 2 (user 4).
const OTHER_PATIENT = { userId: 5, patientId: 3 }

let ctx: InternalTestContext

beforeAll(async () => {
  ctx = await createInternalTestContext()
})

beforeEach(async () => {
  await ctx.reset()
})

afterAll(async () => {
  await ctx.close()
})

interface Line {
  productIndex: number
  quantity: number
  /** Added to the product's cost; 0 with quantity 1 can still be a minimum price. */
  unitPriceCents: number
}

/** Sends an order from `providerUserId` to `patientId` and pays it as `patientUserId`. */
async function paidOrder(
  providerUserId: number,
  patientId: number,
  patientUserId: number,
  lines: Line[],
): Promise<{ id: number; split: OrderSplit }> {
  const created = await ctx.request
    .post('/api/orders')
    .set(as(providerUserId))
    .send({ patientId })
  expect(created.status).toBe(201)
  const id: number = created.body.id
  const draftLines = lines.map((line) => ({
    productId: ctx.seed.products[line.productIndex]!.id,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
  }))
  expect(
    (
      await ctx.request
        .put(`/api/orders/${id}/lines`)
        .set(as(providerUserId))
        .send({ lines: draftLines })
    ).status,
  ).toBe(200)
  const sent = await ctx.request
    .post(`/api/orders/${id}/send`)
    .set(as(providerUserId))
  expect(sent.status).toBe(200)
  const paid = await ctx.request
    .post(`/api/orders/${id}/pay`)
    .set(as(patientUserId))
    .send({
      expectedRevision: sent.body.revision,
      expectedTotalCents: sent.body.split.totalCents,
    })
  expect(paid.status).toBe(200)
  const split = computeSplit(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      unitCogsCents: ctx.seed.products[line.productIndex]!.cogsCents,
    })),
  )
  return { id, split }
}

function trialBalance(userId = ctx.seed.adminUserId) {
  return ctx.request.get('/api/admin/accounts').set(as(userId))
}

function journals(
  query: Record<string, string> = {},
  userId = ctx.seed.adminUserId,
) {
  return ctx.request.get('/api/admin/journals').query(query).set(as(userId))
}

describe('GET /api/admin/accounts and /api/admin/journals', () => {
  it('rejects providers and patients with 403 and no user with 401', async () => {
    const responses = await Promise.all(
      [ctx.seed.providerUserId, ctx.seed.patientUserId].flatMap((userId) => [
        trialBalance(userId),
        journals({}, userId),
      ]),
    )
    responses.forEach((res) => {
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN'])
    })
    const anonymous = await Promise.all([
      ctx.request.get('/api/admin/accounts'),
      ctx.request.get('/api/admin/journals'),
    ])
    anonymous.forEach((res) => expect(res.status).toBe(401))
  })

  it('lists every account at zero before any payment', async () => {
    const res = await trialBalance()

    expect(res.status).toBe(200)
    const body = adminTrialBalanceDtoSchema.parse(res.body)
    expect(
      body.accounts.map((a) => [a.code, a.name, a.type, a.normalBalance]),
    ).toEqual([
      ['1000', 'Cash', 'asset', 'debit'],
      ['2100-1', 'Payable to Dr. Maya Rivera', 'liability', 'credit'],
      ['2100-2', 'Payable to Dr. Owen Brooks', 'liability', 'credit'],
      ['4000', 'Product sales at wholesale cost', 'revenue', 'credit'],
      ['4100', 'Platform fee revenue', 'revenue', 'credit'],
    ])
    expect(body.accounts.map((a) => a.providerId)).toEqual([
      null,
      1,
      2,
      null,
      null,
    ])
    body.accounts.forEach((a) =>
      expect([a.debitsCents, a.creditsCents, a.balanceCents]).toEqual([
        0, 0, 0,
      ]),
    )
    expect(body.totals).toEqual({ debitsCents: 0, creditsCents: 0 })
    expect(adminJournalPageDtoSchema.parse((await journals()).body)).toEqual({
      items: [],
      total: 0,
      offset: 0,
      limit: 25,
    })
  })

  it('balances after several payments across both providers', async () => {
    const orders = [
      await paidOrder(
        ctx.seed.providerUserId,
        ctx.seed.patientId,
        ctx.seed.patientUserId,
        [
          { productIndex: 0, quantity: 2, unitPriceCents: 2000 },
          { productIndex: 1, quantity: 1, unitPriceCents: 1500 },
        ],
      ),
      await paidOrder(
        ctx.seed.otherProviderUserId,
        OTHER_PATIENT.patientId,
        OTHER_PATIENT.userId,
        [{ productIndex: 2, quantity: 3, unitPriceCents: 2500 }],
      ),
      // At the minimum price the margin is 0, so this journal has no payable posting.
      await paidOrder(
        ctx.seed.providerUserId,
        ctx.seed.patientId,
        ctx.seed.patientUserId,
        [{ productIndex: 0, quantity: 1, unitPriceCents: 857 }],
      ),
    ]
    expect(orders[2]!.split.providerMarginCents).toBe(0)
    const sum = (pick: (split: OrderSplit) => number, which = orders) =>
      which.reduce((total, order) => total + pick(order.split), 0)
    const own = [orders[0]!, orders[2]!]

    const body = adminTrialBalanceDtoSchema.parse((await trialBalance()).body)

    const byCode = Object.fromEntries(body.accounts.map((a) => [a.code, a]))
    expect(byCode['1000']).toMatchObject({
      debitsCents: sum((s) => s.totalCents),
      creditsCents: 0,
      balanceCents: sum((s) => s.totalCents),
    })
    expect(byCode['4000']).toMatchObject({
      debitsCents: 0,
      creditsCents: sum((s) => s.cogsCents),
      balanceCents: sum((s) => s.cogsCents),
    })
    expect(byCode['4100']).toMatchObject({
      creditsCents: sum((s) => s.platformFeeCents),
      balanceCents: sum((s) => s.platformFeeCents),
    })
    expect(byCode['2100-1']!.balanceCents).toBe(
      sum((s) => s.providerMarginCents, own),
    )
    expect(byCode['2100-2']!.balanceCents).toBe(
      orders[1]!.split.providerMarginCents,
    )
    expect(body.totals.debitsCents).toBe(body.totals.creditsCents)
    expect(body.totals.debitsCents).toBe(sum((s) => s.totalCents))

    // The provider's Owed to you is its payable balance.
    const dashboard = await ctx.request
      .get('/api/dashboard')
      .query({ range: 'all' })
      .set(as(ctx.seed.providerUserId))
    expect(dashboard.body.owedToYouCents).toBe(byCode['2100-1']!.balanceCents)

    const page = adminJournalPageDtoSchema.parse((await journals()).body)
    expect(page.total).toBe(3)
    // Newest first.
    expect(page.items.map((j) => j.orderId)).toEqual(
      orders.map((o) => o.id).reverse(),
    )
    expect(page.items[0]).toMatchObject({
      kind: 'patient_payment',
      memo: `Patient payment for order #${orders[2]!.id}`,
      providerName: 'Dr. Maya Rivera',
    })
    expect(page.items[0]!.postings.map((p) => p.accountCode)).toEqual([
      '1000',
      '4000',
      '4100',
    ])
    expect(page.items[1]).toMatchObject({
      providerName: 'Dr. Owen Brooks',
    })
    expect(page.items[1]!.postings).toEqual([
      {
        accountCode: '1000',
        accountName: 'Cash',
        debitCents: orders[1]!.split.totalCents,
        creditCents: null,
      },
      {
        accountCode: '4000',
        accountName: 'Product sales at wholesale cost',
        debitCents: null,
        creditCents: orders[1]!.split.cogsCents,
      },
      {
        accountCode: '2100-2',
        accountName: 'Payable to Dr. Owen Brooks',
        debitCents: null,
        creditCents: orders[1]!.split.providerMarginCents,
      },
      {
        accountCode: '4100',
        accountName: 'Platform fee revenue',
        debitCents: null,
        creditCents: orders[1]!.split.platformFeeCents,
      },
    ])

    const second = adminJournalPageDtoSchema.parse(
      (await journals({ offset: '1', limit: '1' })).body,
    )
    expect(second.items.map((j) => j.id)).toEqual([page.items[1]!.id])
    expect(second).toMatchObject({ total: 3, offset: 1, limit: 1 })
  })

  it('gives each partial payment of a back-order chain its own journal', async () => {
    const product = ctx.seed.products[0]!
    const { id } = await (async () => {
      const created = await ctx.request
        .post('/api/orders')
        .set(as(ctx.seed.providerUserId))
        .send({ patientId: ctx.seed.patientId })
      return created.body as { id: number }
    })()
    await ctx.request
      .put(`/api/orders/${id}/lines`)
      .set(as(ctx.seed.providerUserId))
      .send({
        lines: [
          {
            productId: product.id,
            quantity: product.stockQuantity + 2,
            unitPriceCents: product.cogsCents + 500,
          },
        ],
      })
    const sent = await ctx.request
      .post(`/api/orders/${id}/send`)
      .set(as(ctx.seed.providerUserId))
      .send({ acknowledgeLowStock: true })
    expect(sent.status).toBe(200)
    const quote = sent.body.partialPaymentQuote
    const partial = await pay(ctx, id, {
      mode: 'available',
      expectedTotalCents: quote.pay.totalCents,
      expectedPayableLines: [
        { productId: product.id, quantity: product.stockQuantity },
      ],
    })
    expect(partial.status).toBe(200)
    const backorderId: number = partial.body.backorderOrderId
    await ctx.request
      .post(`/api/admin/products/${product.id}/stock/increment`)
      .set(as(ctx.seed.adminUserId))
      .send({ by: 5 })
    expect((await pay(ctx, backorderId)).status).toBe(200)

    const page = adminJournalPageDtoSchema.parse((await journals()).body)
    expect(page.items.map((j) => j.orderId)).toEqual([backorderId, id])
    page.items.forEach((journal) => {
      const debits = journal.postings.reduce(
        (s, p) => s + (p.debitCents ?? 0),
        0,
      )
      const credits = journal.postings.reduce(
        (s, p) => s + (p.creditCents ?? 0),
        0,
      )
      expect(debits).toBe(credits)
    })
    const body = adminTrialBalanceDtoSchema.parse((await trialBalance()).body)
    expect(body.totals.debitsCents).toBe(body.totals.creditsCents)
  })

  it('validates the journal page query', async () => {
    const res = await journals({ limit: '0' })
    expect([res.status, res.body.error.code, res.body.error.field]).toEqual([
      400,
      'VALIDATION_ERROR',
      'limit',
    ])
  })
})
