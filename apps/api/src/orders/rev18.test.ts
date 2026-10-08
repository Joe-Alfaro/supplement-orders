import { expectedPayableLinesOf } from '@supplement-orders/domain'
import { eq, sql } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { fakeGatewayCharges, orderItems, orders, payments } from '../db/schema'
import {
  as,
  createSentOrder,
  journalSplitOf,
  moneyState,
  pay,
  setStock,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 18 (notes/DOMAIN_CONTRACT.md 18.1, 18.2, 18.4 L4/L5). Seams used:
// ctx.clock for the 15-minute abandon window, vi.spyOn(ctx.gateway, 'charge')
// for transport errors, and direct SQL for durable state.
describe('revision 18 payment recovery, back-orders and fee conservation', () => {
  let ctx: InternalTestContext
  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx?.close()
  })

  const provider = () => as(ctx.seed.providerUserId)
  const admin = () => as(ctx.seed.adminUserId)

  function detail(id: number, user = ctx.seed.patientUserId) {
    return ctx.request.get(`/api/orders/${id}`).set(as(user))
  }
  function action(id: number, name: 'send' | 'cancel' | 'reopen') {
    return ctx.request.post(`/api/orders/${id}/${name}`).set(provider())
  }
  /** The available-mode body for exactly the quote the patient is offered. */
  async function availableBody(id: number) {
    const view = await detail(id)
    expect(view.status).toBe(200)
    return {
      mode: 'available',
      expectedRevision: view.body.revision,
      expectedTotalCents: view.body.partialPaymentQuote.pay.totalCents,
      expectedPayableLines: expectedPayableLinesOf(view.body.lines),
    }
  }
  async function childrenOf(id: number) {
    return (
      await ctx.db.execute<{ id: number; status: string }>(
        sql`select id, status from orders where split_from_order_id = ${id} order by id`,
      )
    ).rows
  }
  async function itemsOf(id: number) {
    return (
      await ctx.db
        .select({
          productId: orderItems.productId,
          quantity: orderItems.quantity,
          unitPriceCents: orderItems.unitPriceCents,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, id))
        .orderBy(orderItems.productId)
    ).map((row) => ({ ...row }))
  }
  async function stockOf(productId: number) {
    return (await moneyState(ctx, 0)).stock.find((p) => p.id === productId)!
      .stockQuantity
  }

  // ---------------------------------------------------------------- 18.1
  async function shortOrder() {
    const [a, b, c] = ctx.seed.products
    const lines = [a!, b!, c!].map((product, index) => ({
      productId: product.id,
      quantity: [5, 2, 1][index]!,
      unitPriceCents: product.cogsCents + 1000,
    }))
    const id = await createSentOrder(ctx, lines)
    await setStock(ctx, a!.id, 2)
    await setStock(ctx, b!.id, 0)
    await setStock(ctx, c!.id, 10)
    return { id, lines }
  }
  const byProduct = <T extends { productId: number }>(rows: T[]) =>
    [...rows].sort((x, y) => x.productId - y.productId)

  async function r2UpToReopen() {
    const f = await shortOrder()
    const declined = await pay(ctx, f.id, {
      ...(await availableBody(f.id)),
      simulateFailure: true,
    })
    expect(declined.status).toBe(402)
    const [firstChild] = await childrenOf(f.id)
    expect(firstChild).toBeDefined()
    expect((await action(f.id, 'cancel')).status).toBe(200)
    expect((await action(f.id, 'reopen')).status).toBe(200)
    return { ...f, firstChildId: firstChild!.id }
  }

  it("18.1 the auditor's R2 sequence (split, decline, cancel, reopen, resend, partial pay) ends in 200 with one new live back-order", async () => {
    const f = await r2UpToReopen()
    expect(
      (
        await ctx.request
          .post(`/api/orders/${f.id}/send`)
          .set(provider())
          .send({ acknowledgeLowStock: true })
      ).status,
    ).toBe(200)
    const response = await pay(ctx, f.id, await availableBody(f.id))
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('paid')
    const children = await childrenOf(f.id)
    expect(children).toHaveLength(2)
    expect(children.filter((c) => c.status !== 'cancelled')).toHaveLength(1)
    expect(children[0]).toMatchObject({
      id: f.firstChildId,
      status: 'cancelled',
    })
    expect(response.body.backorderOrderId).toBe(children[1]!.id)
    expect(response.body.backorderOrderId).not.toBe(f.firstChildId)
    expect(await ctx.db.select().from(payments)).toHaveLength(1)
  })

  it('18.1 reopening a cancelled original merges its cancelled back-orders back into the draft at the original prices', async () => {
    const f = await r2UpToReopen()
    expect(await itemsOf(f.id)).toEqual(
      byProduct(f.lines).map(({ productId, quantity, unitPriceCents }) => ({
        productId,
        quantity,
        unitPriceCents,
      })),
    )
    const [reopened] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, f.id))
    expect(reopened!.status).toBe('draft')
    // The cancelled back-order stays as history.
    expect((await childrenOf(f.id))[0]).toMatchObject({
      id: f.firstChildId,
      status: 'cancelled',
    })
    expect((await itemsOf(f.firstChildId)).length).toBeGreaterThan(0)
    // The provider sends the whole original order again.
    expect(
      (
        await ctx.request
          .post(`/api/orders/${f.id}/send`)
          .set(provider())
          .send({ acknowledgeLowStock: true })
      ).status,
    ).toBe(200)
    const sent = await detail(f.id, ctx.seed.providerUserId)
    expect(sent.body.split.totalCents).toBe(
      f.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0),
    )
  })

  it('18.1 findBackorder ignores cancelled children: a cancelled child no longer blocks a new split', async () => {
    const f = await r2UpToReopen()
    expect(
      (
        await ctx.request
          .post(`/api/orders/${f.id}/send`)
          .set(provider())
          .send({ acknowledgeLowStock: true })
      ).status,
    ).toBe(200)
    expect((await pay(ctx, f.id, await availableBody(f.id))).status).toBe(200)
  })

  /**
   * Every combination of payable state and live back-order. Whatever quote the
   * detail endpoint offers must be payable by sending it back unchanged.
   */
  const scenarios = [
    {
      name: 'short, in stock, no back-order',
      backorder: false,
      stock: [2, 0, 10],
    },
    {
      name: 'short, nothing in stock, no back-order',
      backorder: false,
      stock: [0, 0, 0],
    },
    {
      name: 'live back-order, short again, in stock',
      backorder: true,
      stock: [1, 0, 10],
    },
    {
      name: 'live back-order, short again, nothing in stock',
      backorder: true,
      stock: [0, 0, 0],
    },
    {
      name: 'live back-order, restocked',
      backorder: true,
      stock: [50, 50, 50],
    },
  ] as const
  it.each(scenarios)(
    '18.1 an offered quote round-trips: $name',
    async ({ backorder, stock }) => {
      const f = await shortOrder()
      if (backorder) {
        const split = await pay(ctx, f.id, {
          ...(await availableBody(f.id)),
          simulateFailure: true,
        })
        expect(split.status).toBe(402)
        expect(
          (await childrenOf(f.id)).filter((c) => c.status !== 'cancelled'),
        ).toHaveLength(1)
      }
      await Promise.all(
        f.lines.map((line, i) => setStock(ctx, line.productId, stock[i]!)),
      )
      const view = await detail(f.id)
      const quote = view.body.partialPaymentQuote
      expect(quote).not.toBeNull()
      const before = await moneyState(ctx, f.id)
      if (backorder && quote.hasShortfall) {
        expect(quote.payable).toBe(false)
        expect(quote.reason).toBe('awaiting_restock')
      }
      if (!quote.payable) {
        const refused = await pay(ctx, f.id, {
          mode: 'available',
          expectedRevision: view.body.revision,
          expectedTotalCents: quote.pay.totalCents,
          expectedPayableLines: expectedPayableLinesOf(view.body.lines),
        })
        expect(refused.status).toBe(409)
        expect(await moneyState(ctx, f.id)).toEqual(before)
        return
      }
      const response = quote.hasShortfall
        ? await pay(ctx, f.id, await availableBody(f.id))
        : await pay(ctx, f.id, {
            expectedRevision: view.body.revision,
            expectedTotalCents: view.body.totalCents,
          })
      expect(response.status).toBe(200)
      expect(response.body.status).toBe('paid')
    },
  )

  it('18.1 the patient is told the order is awaiting restock when a live back-order exists and stock is short again', async () => {
    const f = await shortOrder()
    expect(
      (
        await pay(ctx, f.id, {
          ...(await availableBody(f.id)),
          simulateFailure: true,
        })
      ).status,
    ).toBe(402)
    await setStock(ctx, f.lines[0]!.productId, 1)
    const quote = (await detail(f.id)).body.partialPaymentQuote
    expect(quote).toMatchObject({
      payable: false,
      hasShortfall: true,
      reason: 'awaiting_restock',
    })
  })

  // ---------------------------------------------------------------- 18.2
  const heldSetup = async () => {
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 2, unitPriceCents: 5000 },
    ])
    const stockBefore = await stockOf(product.id)
    return { id, product, stockBefore }
  }
  /** The transport fails after the processor took (or declined) the charge. */
  function failAfterCharge(decline: boolean) {
    const original = ctx.gateway.charge.bind(ctx.gateway)
    vi.spyOn(ctx.gateway, 'charge').mockImplementation(async (req, opts) => {
      await original(req, { ...opts, simulateFailure: decline })
      throw new Error('gateway timeout')
    })
  }
  function failBeforeCharge() {
    vi.spyOn(ctx.gateway, 'charge').mockRejectedValue(new Error('ECONNRESET'))
  }
  async function attemptsOf(orderId: number) {
    return (
      await ctx.db.execute<{
        id: number
        status: string
        stock_held: boolean
        idempotency_key: string
        created_at: Date
      }>(sql`select id, status, stock_held, idempotency_key, created_at
        from payment_attempts where order_id = ${orderId} order by id`)
    ).rows
  }
  function reconcile(attemptId: number, user = admin()) {
    return ctx.request
      .post(`/api/admin/payment-attempts/${attemptId}/reconcile`)
      .set(user)
  }

  it('18.2 a throwing gateway gives 503 PAYMENT_PENDING, keeps the attempt pending and the stock held; reconciling as succeeded records exactly one payment and one charge', async () => {
    const { id, product, stockBefore } = await heldSetup()
    failAfterCharge(false)
    const response = await pay(ctx, id)
    expect(response.status).toBe(503)
    expect(response.body.error).toMatchObject({
      code: 'PAYMENT_PENDING',
      orderId: id,
      revision: expect.any(Number),
      amountCents: 10000,
    })
    const [attempt] = await attemptsOf(id)
    expect(attempt).toMatchObject({ status: 'pending', stock_held: true })
    expect(await stockOf(product.id)).toBe(stockBefore - 2)
    expect((await detail(id)).body.paymentInProgress).toBeTruthy()
    vi.restoreAllMocks()

    const first = await reconcile(attempt!.id)
    expect(first.status).toBe(200)
    const second = await reconcile(attempt!.id)
    expect(second.status).toBe(200)
    const state = await moneyState(ctx, id)
    expect(state.order?.status).toBe('paid')
    expect(state.payments).toHaveLength(1)
    expect(state.journals).toHaveLength(1)
    expect(journalSplitOf(state.postings).totalCents).toBe(10000)
    expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(1)
    expect(ctx.gateway.charges).toHaveLength(1)
    expect(await stockOf(product.id)).toBe(stockBefore - 2)
    expect((await attemptsOf(id))[0]!.status).toBe('succeeded')
  })

  it('18.2 reconciling a declined attempt marks it declined and releases its stock exactly once', async () => {
    const { id, product, stockBefore } = await heldSetup()
    failAfterCharge(true)
    expect((await pay(ctx, id)).status).toBe(503)
    vi.restoreAllMocks()
    const [attempt] = await attemptsOf(id)
    expect(await stockOf(product.id)).toBe(stockBefore - 2)
    expect((await reconcile(attempt!.id)).status).toBe(200)
    expect(await attemptsOf(id)).toMatchObject([
      { status: 'declined', stock_held: false },
    ])
    expect(await stockOf(product.id)).toBe(stockBefore)
    // Idempotent: a second reconcile never releases the same stock again.
    expect((await reconcile(attempt!.id)).status).toBe(200)
    expect(await stockOf(product.id)).toBe(stockBefore)
    expect(await ctx.db.select().from(payments)).toHaveLength(0)
    // The order can be paid again afterwards.
    expect((await pay(ctx, id)).status).toBe(200)
  })

  it('18.2 an attempt the gateway never saw is abandoned and its stock released only after 15 minutes (injected clock)', async () => {
    const { id, product, stockBefore } = await heldSetup()
    failBeforeCharge()
    expect((await pay(ctx, id)).status).toBe(503)
    vi.restoreAllMocks()
    const [attempt] = await attemptsOf(id)
    const created = new Date(attempt!.created_at).getTime()

    ctx.clock!.now = new Date(created + 14 * 60_000)
    const early = await reconcile(attempt!.id)
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe('RECONCILE_TOO_EARLY')
    expect(await attemptsOf(id)).toMatchObject([
      { status: 'pending', stock_held: true },
    ])
    expect(await stockOf(product.id)).toBe(stockBefore - 2)

    ctx.clock!.now = new Date(created + 16 * 60_000)
    expect((await reconcile(attempt!.id)).status).toBe(200)
    expect(await attemptsOf(id)).toMatchObject([
      { status: 'abandoned', stock_held: false },
    ])
    expect(await stockOf(product.id)).toBe(stockBefore)
    expect((await reconcile(attempt!.id)).status).toBe(200)
    expect(await stockOf(product.id)).toBe(stockBefore)
    expect(await ctx.db.select().from(payments)).toHaveLength(0)
  })

  it('18.2 the admin list shows unresolved attempts with age and no patient fields', async () => {
    const { id } = await heldSetup()
    failBeforeCharge()
    expect((await pay(ctx, id)).status).toBe(503)
    vi.restoreAllMocks()
    const [attempt] = await attemptsOf(id)
    const resolved = await createSentOrder(ctx)
    expect((await pay(ctx, resolved)).status).toBe(200)

    const response = await ctx.request
      .get('/api/admin/payment-attempts')
      .query({ status: 'unresolved' })
      .set(admin())
    expect(response.status).toBe(200)
    const items = response.body as Record<string, unknown>[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: attempt!.id,
      orderId: id,
      providerName: expect.any(String),
      amountCents: 10000,
      status: 'pending',
    })
    expect(Object.keys(items[0]!)).toEqual(
      expect.arrayContaining([
        'id',
        'orderId',
        'providerName',
        'amountCents',
        'status',
      ]),
    )
    const text = JSON.stringify(response.body)
    const patient = (
      await ctx.db.execute<{ name: string; address: string }>(
        sql`select u.name, pt.address from patients pt join users u on u.id = pt.user_id where pt.id = ${ctx.seed.patientId}`,
      )
    ).rows[0]!
    expect(text).not.toContain(patient.name)
    expect(text).not.toContain(patient.address)
    expect(text.toLowerCase()).not.toContain('patient')
    // The same holds for what reconcile returns.
    ctx.clock!.now = new Date(
      new Date(attempt!.created_at).getTime() + 16 * 60_000,
    )
    const reconciled = await reconcile(attempt!.id)
    expect(JSON.stringify(reconciled.body)).not.toContain(patient.name)
    expect(JSON.stringify(reconciled.body)).not.toContain(patient.address)
  })

  it.each(['provider', 'patient'] as const)(
    '18.2 a %s gets 403 from both admin payment endpoints',
    async (role) => {
      const { id } = await heldSetup()
      failBeforeCharge()
      expect((await pay(ctx, id)).status).toBe(503)
      vi.restoreAllMocks()
      const [attempt] = await attemptsOf(id)
      const user = as(
        role === 'provider' ? ctx.seed.providerUserId : ctx.seed.patientUserId,
      )
      const list = await ctx.request
        .get('/api/admin/payment-attempts')
        .query({ status: 'unresolved' })
        .set(user)
      expect(list.status).toBe(403)
      const result = await reconcile(attempt!.id, user)
      expect(result.status).toBe(403)
      expect((await attemptsOf(id))[0]!.status).toBe('pending')
    },
  )

  // ------------------------------------------------------------ 18.4 L4
  const KEY =
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-order-(\d+)-r(\d+)-e(\d+)$/

  it('L4 keys are <installId>-order-<id>-r<rev>-e<n> with one install id across orders and restarts', async () => {
    const first = await createSentOrder(ctx)
    const second = await createSentOrder(ctx)
    expect((await pay(ctx, first)).status).toBe(200)
    ctx.restart()
    expect((await pay(ctx, second)).status).toBe(200)
    const keys = [
      ...(await attemptsOf(first)),
      ...(await attemptsOf(second)),
    ].map((a) => a.idempotency_key)
    expect(keys).toHaveLength(2)
    keys.forEach((key) => expect(key).toMatch(KEY))
    const prefixes = keys.map((key) => key.split('-order-')[0])
    expect(new Set(prefixes).size).toBe(1)
    expect(keys[0]).toMatch(new RegExp(`-order-${first}-r\\d+-e1$`))
    const charged = await ctx.db.select().from(fakeGatewayCharges)
    expect(charged.map((c) => c.idempotencyKey).sort()).toEqual(
      [...keys].sort(),
    )
  })

  it('L4 an existing attempt keeps its legacy key', async () => {
    const id = await createSentOrder(ctx)
    const legacy = `order-${id}-r1-e1`
    await ctx.db.execute(sql`insert into payment_attempts
      (order_id, revision, execution, idempotency_key, amount_cents, status, stock_held)
      select id, revision, 1, ${legacy}, total_cents, 'pending', false from orders where id = ${id}`)
    expect((await pay(ctx, id)).status).toBe(200)
    expect(ctx.gateway.charges.map((c) => c.idempotencyKey)).toEqual([legacy])
    expect((await attemptsOf(id)).map((a) => a.idempotency_key)).toEqual([
      legacy,
    ])
  })

  // ------------------------------------------------------------ 18.4 L5
  async function feeOf(id: number) {
    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, id))
    if (row?.platformFeeCents == null || row.subtotalCents == null) {
      throw new Error(`Order ${id} has no fee snapshot`)
    }
    return {
      ...row,
      platformFeeCents: row.platformFeeCents,
      subtotalCents: row.subtotalCents,
    }
  }
  async function journalFee(id: number) {
    return -(await moneyState(ctx, id)).postings
      .filter((p) => p.accountCode === '4100')
      .reduce((sum, p) => sum + p.amountCents, 0)
  }
  const unsplitFee = (subtotal: number) => Math.ceil((75 * subtotal) / 10000)

  it("L5 the auditor's R5 case: a 17¢ order split in two still charges 17¢ across the chain", async () => {
    const product = ctx.seed.products[0]!
    // 2 x 1100 = 2200 -> 17¢ unsplit; 1100 + 1100 would be 9¢ + 9¢ = 18¢ if each half were recomputed.
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 2, unitPriceCents: 1100 },
    ])
    expect((await feeOf(id)).platformFeeCents).toBe(17)
    await setStock(ctx, product.id, 1)
    const paid = await pay(ctx, id, await availableBody(id))
    expect(paid.status).toBe(200)
    const childId: number = paid.body.backorderOrderId
    const [parent, child] = [await feeOf(id), await feeOf(childId)]
    expect(parent.platformFeeCents).toBe(9)
    expect(child.platformFeeCents).toBe(8)
    expect(parent.platformFeeCents + child.platformFeeCents).toBe(17)
    expect(
      child.subtotalCents - product.cogsCents - child.platformFeeCents,
    ).toBeGreaterThanOrEqual(0)
    expect(await journalFee(id)).toBe(9)

    await setStock(ctx, product.id, 1)
    expect((await pay(ctx, childId)).status).toBe(200)
    expect(await journalFee(childId)).toBe(8)
    expect((await journalFee(id)) + (await journalFee(childId))).toBe(17)
  })

  it('L5 the fee is conserved across a three-order chain and every back-order margin is non-negative', async () => {
    const product = ctx.seed.products[0]!
    // 3 x 1100 = 3300 -> 25¢ unsplit; each 1100 unit alone is 9¢, so recomputing would give 27¢.
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 3, unitPriceCents: 1100 },
    ])
    const total = unsplitFee(3300)
    expect(total).toBe(25)
    await setStock(ctx, product.id, 1)
    const first = await pay(ctx, id, await availableBody(id))
    expect(first.status).toBe(200)
    const second: number = first.body.backorderOrderId
    expect((await feeOf(second)).platformFeeCents).toBe(total - 9)
    await setStock(ctx, product.id, 1)
    const middle = await pay(ctx, second, await availableBody(second))
    expect(middle.status).toBe(200)
    const third: number = middle.body.backorderOrderId
    await setStock(ctx, product.id, 1)
    expect((await pay(ctx, third)).status).toBe(200)

    const chain = await Promise.all([id, second, third].map(feeOf))
    expect(chain.reduce((sum, o) => sum + o.platformFeeCents, 0)).toBe(total)
    chain.forEach((o) => {
      expect(o.platformFeeCents).toBeGreaterThanOrEqual(0)
      expect(o.subtotalCents - o.platformFeeCents).toBeGreaterThanOrEqual(
        product.cogsCents * (o.subtotalCents / 1100),
      )
    })
    const journalFees = await Promise.all([id, second, third].map(journalFee))
    expect(journalFees).toEqual(chain.map((o) => o.platformFeeCents))
    expect(journalFees.reduce((a, b) => a + b, 0)).toBe(total)
  })
})
