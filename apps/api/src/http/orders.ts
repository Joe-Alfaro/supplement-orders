import {
  createOrderRequestSchema,
  listOrdersQuerySchema,
  payOrderRequestSchema,
  replaceOrderLinesRequestSchema,
} from '@supplement-orders/domain'
import { eq } from 'drizzle-orm'
import { Router } from 'express'
import { patients } from '../db/schema'
import {
  cancelOrder,
  createDraft,
  deleteDraft,
  payOrder,
  reopenOrder,
  replaceDraftLines,
  sendOrder,
} from '../orders/service'
import {
  findOrderOwnership,
  listProviderOrderPage,
  listPatientOrders,
  listProviderOrders,
  loadPatientOrderDetail,
  loadProviderOrderDetail,
} from '../orders/views'
import { requireRole, type CurrentUser } from '../seams'
import type { AppContext } from '../server'
import { forbidden, notFound } from './errors'
import { parseId, parseOrThrow } from './validate'

export function ordersRouter(ctx: AppContext) {
  const { db, auth } = ctx
  const router = Router()

  async function assertOwnPatient(
    user: Extract<CurrentUser, { role: 'provider' }>,
    patientId: number,
  ) {
    const [patient] = await db
      .select({ providerId: patients.providerId })
      .from(patients)
      .where(eq(patients.id, patientId))
    if (!patient) throw notFound('Patient')
    if (patient.providerId !== user.providerId) throw forbidden()
  }

  /** 404 if missing (or a draft, for its patient); 403 if not the caller's. */
  async function assertCanView(user: CurrentUser, orderId: number) {
    const order = await findOrderOwnership(db, orderId)
    if (!order) throw notFound('Order')
    if (user.role === 'provider') {
      if (order.providerId !== user.providerId) throw forbidden()
      return
    }
    if (order.patientId !== user.patientId) throw forbidden()
    // Unsent orders (drafts, and drafts cancelled before sending) stay hidden.
    if (order.sentAt === null) throw notFound('Order')
  }

  router.get('/', async (req, res) => {
    const user = await auth.getCurrentUser(req)
    const { patientId, status, offset, limit } = parseOrThrow(
      listOrdersQuerySchema,
      req.query,
    )
    if (status !== undefined) {
      const provider = requireRole(user, 'provider')
      if (patientId !== undefined) await assertOwnPatient(provider, patientId)
      res.json(
        await listProviderOrderPage(db, provider.providerId, {
          status,
          patientId,
          offset,
          limit,
        }),
      )
      return
    }
    if (user.role === 'patient') {
      if (patientId !== undefined && patientId !== user.patientId) {
        throw forbidden()
      }
      res.json(await listPatientOrders(db, user.patientId))
      return
    }
    if (patientId !== undefined) await assertOwnPatient(user, patientId)
    res.json(await listProviderOrders(db, user.providerId, patientId))
  })

  router.post('/', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const { patientId } = parseOrThrow(createOrderRequestSchema, req.body)
    const orderId = await createDraft(db, user, patientId)
    res.status(201).json(await loadProviderOrderDetail(db, orderId))
  })

  router.get('/:id', async (req, res) => {
    const user = await auth.getCurrentUser(req)
    const orderId = parseId(req.params.id)
    await assertCanView(user, orderId)
    res.json(
      user.role === 'provider'
        ? await loadProviderOrderDetail(db, orderId)
        : await loadPatientOrderDetail(db, orderId),
    )
  })

  router.put('/:id/lines', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const orderId = parseId(req.params.id)
    const { lines } = parseOrThrow(replaceOrderLinesRequestSchema, req.body)
    await replaceDraftLines(db, user, orderId, lines)
    res.json(await loadProviderOrderDetail(db, orderId))
  })

  router.post('/:id/send', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const orderId = parseId(req.params.id)
    await sendOrder(ctx, user, orderId)
    res.json(await loadProviderOrderDetail(db, orderId))
  })

  router.delete('/:id', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const orderId = parseId(req.params.id)
    await deleteDraft(db, user, orderId)
    res.status(204).end()
  })

  router.post('/:id/reopen', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const orderId = parseId(req.params.id)
    await reopenOrder(db, user, orderId)
    res.json(await loadProviderOrderDetail(db, orderId))
  })

  router.post('/:id/cancel', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'provider')
    const orderId = parseId(req.params.id)
    await cancelOrder(ctx, user, orderId)
    res.json(await loadProviderOrderDetail(db, orderId))
  })

  router.post('/:id/pay', async (req, res) => {
    const user = requireRole(await auth.getCurrentUser(req), 'patient')
    const orderId = parseId(req.params.id)
    const body = parseOrThrow(payOrderRequestSchema, req.body ?? {})
    await payOrder(ctx, user, orderId, body.simulateFailure === true)
    res.json(await loadPatientOrderDetail(db, orderId))
  })

  return router
}
