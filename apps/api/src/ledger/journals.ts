import {
  assertJournalBalances,
  paymentJournal,
  splitFromPostings,
  SYSTEM_ACCOUNTS,
  type AdminJournalDto,
  type AdminTrialBalanceDto,
  type JournalDto,
  type JournalPostingDto,
  type JournalSplit,
  type OrderSplit,
  type PaymentJournalAccount,
} from '@supplement-orders/domain'
import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '../db/client'
import {
  accounts,
  journals,
  orders,
  patients,
  postings,
  providers,
  users,
} from '../db/schema'

/** A database handle or a transaction. */
type Reader = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

const SYSTEM_ACCOUNT_ROLES = {
  [SYSTEM_ACCOUNTS.cash.code]: 'cash',
  [SYSTEM_ACCOUNTS.productSales.code]: 'product_sales',
  [SYSTEM_ACCOUNTS.platformFee.code]: 'platform_fee',
} as const satisfies Record<string, PaymentJournalAccount>

/** Which line of a patient payment an account is, or null for none. */
function paymentRole(account: {
  code: string
  providerId: number | null
}): PaymentJournalAccount | null {
  if (account.providerId !== null) return 'provider_payable'
  return (
    SYSTEM_ACCOUNT_ROLES[account.code as keyof typeof SYSTEM_ACCOUNT_ROLES] ??
    null
  )
}

export function journalMemo(orderId: number) {
  return `Patient payment for order #${orderId}`
}

export interface PaymentJournalInput {
  paymentId: number
  orderId: number
  providerId: number
  amountCents: number
  split: OrderSplit
}

/**
 * Revision 16.4: writes the payment's journal inside the finalize transaction.
 * Cash is debited with the payment and the split's cogs, margin and fee are
 * credited; migration 0014's deferred triggers re-check all of it at commit.
 */
export async function postPaymentJournal(
  tx: Reader,
  input: PaymentJournalInput,
) {
  const rows = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      providerId: accounts.providerId,
    })
    .from(accounts)
    .where(
      or(
        inArray(accounts.code, Object.keys(SYSTEM_ACCOUNT_ROLES)),
        eq(accounts.providerId, input.providerId),
      ),
    )
  const idFor = (role: PaymentJournalAccount) => {
    const account = rows.find((row) => paymentRole(row) === role)
    if (!account) {
      throw new Error(
        `No ${role} account for provider ${input.providerId}; migration 0014 creates it`,
      )
    }
    return account.id
  }
  const payable = rows.find((row) => row.providerId === input.providerId)
  const drafts = paymentJournal(input.split, {
    cashAccountId: idFor('cash'),
    productSalesAccountId: idFor('product_sales'),
    providerAccountId: idFor('provider_payable'),
    providerAccountCode: payable?.code,
    platformFeeAccountId: idFor('platform_fee'),
  })
  assertJournalBalances(drafts)
  if (splitFromPostings(drafts).totalCents !== input.amountCents) {
    throw new Error(
      `Journal for order ${input.orderId} debits ${input.split.totalCents} but ${input.amountCents} was paid`,
    )
  }

  const [journal] = await tx
    .insert(journals)
    .values({
      kind: 'patient_payment',
      paymentId: input.paymentId,
      orderId: input.orderId,
      memo: journalMemo(input.orderId),
    })
    .returning({ id: journals.id })
  if (!journal) throw new Error('Journal insert returned no row')
  await tx.insert(postings).values(
    drafts.map((draft) => {
      if (draft.accountId === undefined) {
        throw new Error(`No account id for posting to ${draft.accountCode}`)
      }
      return {
        journalId: journal.id,
        accountId: draft.accountId,
        amountCents: draft.amountCents,
      }
    }),
  )
}

const postingColumns = {
  journalId: postings.journalId,
  accountCode: accounts.code,
  accountName: accounts.name,
  accountProviderId: accounts.providerId,
  amountCents: postings.amountCents,
}

interface PostingRow {
  journalId: number
  accountCode: string
  accountName: string
  accountProviderId: number | null
  amountCents: number
}

/** The postings of these journals, each journal's in posting order. */
async function selectPostings(db: Reader, journalIds: number[]) {
  if (journalIds.length === 0) return []
  return db
    .select(postingColumns)
    .from(postings)
    .innerJoin(accounts, eq(accounts.id, postings.accountId))
    .where(inArray(postings.journalId, journalIds))
    .orderBy(asc(postings.journalId), asc(postings.id))
}

function postingDto(row: PostingRow): JournalPostingDto {
  return {
    accountCode: row.accountCode,
    accountName: row.accountName,
    debitCents: row.amountCents > 0 ? row.amountCents : null,
    creditCents: row.amountCents < 0 ? -row.amountCents : null,
  }
}

function splitOf(rows: PostingRow[]): JournalSplit {
  return splitFromPostings(rows)
}

function groupByJournal(rows: PostingRow[]) {
  return rows.reduce((acc, row) => {
    acc.set(row.journalId, [...(acc.get(row.journalId) ?? []), row])
    return acc
  }, new Map<number, PostingRow[]>())
}

async function selectPaymentJournals(db: Reader, orderIds: number[]) {
  if (orderIds.length === 0) return []
  return db
    .select({
      id: journals.id,
      orderId: journals.orderId,
      memo: journals.memo,
      postedAt: journals.postedAt,
    })
    .from(journals)
    .where(
      and(
        inArray(journals.orderId, orderIds),
        eq(journals.kind, 'patient_payment'),
      ),
    )
}

/**
 * Revision 16.4: each paid order's split as its journal recorded it, keyed by
 * order id. Paid splits come from here, never from a recomputation.
 */
export async function selectJournalSplits(db: Reader, orderIds: number[]) {
  const heads = await selectPaymentJournals(db, orderIds)
  const byJournal = groupByJournal(
    await selectPostings(
      db,
      heads.map((head) => head.id),
    ),
  )
  return new Map(
    heads.map((head) => [head.orderId!, splitOf(byJournal.get(head.id) ?? [])]),
  )
}

/** The order's payment journal and the split read from it, if it is paid. */
export async function selectOrderJournal(db: Reader, orderId: number) {
  const [head] = await selectPaymentJournals(db, [orderId])
  if (!head) return { journal: null, split: undefined }
  const rows = await selectPostings(db, [head.id])
  const journal: JournalDto = {
    id: head.id,
    postedAt: head.postedAt.toISOString(),
    memo: head.memo,
    postings: rows.map(postingDto),
  }
  return { journal, split: splitOf(rows) }
}

/** Sums arrive as decimal text; anything past MAX_SAFE_INTEGER is refused. */
function exactCents(value: string, what: string) {
  const cents = BigInt(value)
  if (
    cents > BigInt(Number.MAX_SAFE_INTEGER) ||
    cents < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${what} exceeds the exact cent range`)
  }
  return Number(cents)
}

/**
 * Revision 16.4: every account with its debit and credit totals and its
 * balance toward its normal side, ordered by code, plus the ledger totals.
 */
export async function trialBalance(db: Db): Promise<AdminTrialBalanceDto> {
  const rows = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      normalBalance: accounts.normalBalance,
      providerId: accounts.providerId,
      debits: sql<string>`coalesce(sum(${postings.amountCents}) filter (where ${postings.amountCents} > 0), 0)::text`,
      credits: sql<string>`coalesce(-sum(${postings.amountCents}) filter (where ${postings.amountCents} < 0), 0)::text`,
    })
    .from(accounts)
    .leftJoin(postings, eq(postings.accountId, accounts.id))
    .groupBy(accounts.id)
    .orderBy(asc(accounts.code))
  const rowsDto = rows.map(({ debits, credits, ...account }) => {
    const debitsCents = exactCents(debits, `Account ${account.code} debits`)
    const creditsCents = exactCents(credits, `Account ${account.code} credits`)
    const balanceCents =
      account.normalBalance === 'debit'
        ? debitsCents - creditsCents
        : creditsCents - debitsCents
    return { ...account, debitsCents, creditsCents, balanceCents }
  })
  // Every posting is on exactly one account, so the rows add up to the ledger.
  const total = (pick: (row: (typeof rowsDto)[number]) => number) =>
    exactCents(
      rowsDto.reduce((sum, row) => sum + BigInt(pick(row)), 0n).toString(),
      'Ledger total',
    )
  return {
    accounts: rowsDto,
    totals: {
      debitsCents: total((row) => row.debitsCents),
      creditsCents: total((row) => row.creditsCents),
    },
  }
}

const patientUsers = alias(users, 'patient_users')
const providerUsers = alias(users, 'provider_users')

/** Revision 16.4: one page of journals, newest first, with their postings. */
export async function listJournals(db: Db, offset: number, limit: number) {
  return db.transaction(
    async (tx) => {
      const [heads, [counted]] = await Promise.all([
        tx
          .select({
            id: journals.id,
            kind: journals.kind,
            postedAt: journals.postedAt,
            memo: journals.memo,
            paymentId: journals.paymentId,
            orderId: journals.orderId,
            patientName: patientUsers.name,
            providerName: providerUsers.name,
          })
          .from(journals)
          .leftJoin(orders, eq(orders.id, journals.orderId))
          .leftJoin(patients, eq(patients.id, orders.patientId))
          .leftJoin(patientUsers, eq(patientUsers.id, patients.userId))
          .leftJoin(providers, eq(providers.id, orders.providerId))
          .leftJoin(providerUsers, eq(providerUsers.id, providers.userId))
          .orderBy(desc(journals.postedAt), desc(journals.id))
          .limit(limit)
          .offset(offset),
        tx.select({ total: count() }).from(journals),
      ])
      const byJournal = groupByJournal(
        await selectPostings(
          tx,
          heads.map((head) => head.id),
        ),
      )
      const items: AdminJournalDto[] = heads.map((head) => ({
        ...head,
        postedAt: head.postedAt.toISOString(),
        postings: (byJournal.get(head.id) ?? []).map(postingDto),
      }))
      return { items, total: counted?.total ?? 0, offset, limit }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
