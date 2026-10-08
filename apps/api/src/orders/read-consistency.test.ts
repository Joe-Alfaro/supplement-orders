import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { as, createSentOrder, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

/** A promise plus the function that resolves it. */
function deferred() {
  const handle = { resolve: () => {} }
  const promise = new Promise<void>((resolve) => {
    handle.resolve = resolve
  })
  return { promise, resolve: () => handle.resolve() }
}

// Revision 11 (third Codex audit, N5): an order detail read is one snapshot. A
// read that overlaps a provider's lifecycle changes returns either the old,
// coherent sent order or 404 for the patient, never the new unsent draft.
describe('order detail reads are one consistent snapshot', () => {
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

  const provider = () => as(ctx.seed.providerUserId)
  const patient = () => as(ctx.seed.patientUserId)

  /** Pauses the next detail GET right after its header read, as the auditor did. */
  function pauseAfterHeader() {
    const reached = deferred()
    const release = deferred()
    ctx.readHooks!.afterOrderHeader = async () => {
      delete ctx.readHooks!.afterOrderHeader
      reached.resolve()
      await release.promise
    }
    return { reached: reached.promise, release: release.resolve }
  }

  it("never shows the patient a draft's lines through a GET overlapping cancel, reopen and edit (audit repro)", async () => {
    const [first, second] = ctx.seed.products
    const orderId = await createSentOrder(ctx, [
      { productId: first!.id, quantity: 1, unitPriceCents: 2000 },
    ])
    const pause = pauseAfterHeader()
    // Supertest sends lazily; .then() starts the request now.
    const reading = ctx.request
      .get(`/api/orders/${orderId}`)
      .set(patient())
      .then((r) => r)
    await pause.reached

    const lifecycle = [
      await ctx.request.post(`/api/orders/${orderId}/cancel`).set(provider()),
      await ctx.request.post(`/api/orders/${orderId}/reopen`).set(provider()),
      await ctx.request
        .put(`/api/orders/${orderId}/lines`)
        .set(provider())
        .send({
          lines: [{ productId: second!.id, quantity: 1, unitPriceCents: 3000 }],
        }),
    ]
    expect(lifecycle.map((r) => r.status)).toEqual([200, 200, 200])
    pause.release()
    const res = await reading

    // Either the old sent order, coherent end to end, or not found.
    if (res.status === 200) {
      expect(res.body).toMatchObject({
        status: 'pending_payment',
        revision: 1,
        totalCents: 2000,
      })
      expect(
        res.body.lines.map(
          (l: { productId: number; unitPriceCents: number }) => [
            l.productId,
            l.unitPriceCents,
          ],
        ),
      ).toEqual([[first!.id, 2000]])
    } else {
      expect(res.status).toBe(404)
    }
    expect(JSON.stringify(res.body)).not.toContain(`"productId":${second!.id}`)

    const fresh = await ctx.request.get(`/api/orders/${orderId}`).set(patient())
    expect(fresh.status).toBe(404)
  })

  it('gives the provider a header, payment and journal from the same moment while a pay commits', async () => {
    const orderId = await createSentOrder(ctx)
    const pause = pauseAfterHeader()
    const reading = ctx.request
      .get(`/api/orders/${orderId}`)
      .set(provider())
      .then((r) => r)
    await pause.reached

    expect((await pay(ctx, orderId)).status).toBe(200)
    pause.release()
    const res = await reading

    expect(res.status).toBe(200)
    // The header was read before the payment, so the rest must agree with it.
    expect(res.body).toMatchObject({ status: 'pending_payment', paidAt: null })
    expect(res.body.payment).toBeNull()
    expect(res.body.journal).toBeNull()

    const fresh = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(provider())
    expect(fresh.body.status).toBe('paid')
    expect(fresh.body.journal.postings).toHaveLength(4)
  })
})
