import { LedgerImbalanceError } from './errors'
import type { OrderSplit } from './split'

/*
 * Revision 16: double-entry ledger. A journal is a set of postings in integer
 * cents, signed: positive = debit, negative = credit. Every journal sums to 0.
 */

export const ACCOUNT_TYPES = [
  'asset',
  'liability',
  'revenue',
  'equity',
] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const NORMAL_BALANCES = ['debit', 'credit'] as const
export type NormalBalance = (typeof NORMAL_BALANCES)[number]

export const JOURNAL_KINDS = ['patient_payment'] as const
export type JournalKind = (typeof JOURNAL_KINDS)[number]

export interface SystemAccount {
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
}

/** Seeded by migration 0014 and restored by every test, seed and e2e reset. */
export const SYSTEM_ACCOUNTS = {
  cash: {
    code: '1000',
    name: 'Cash',
    type: 'asset',
    normalBalance: 'debit',
  },
  productSales: {
    code: '4000',
    name: 'Product sales at wholesale cost',
    type: 'revenue',
    normalBalance: 'credit',
  },
  platformFee: {
    code: '4100',
    name: 'Platform fee revenue',
    type: 'revenue',
    normalBalance: 'credit',
  },
} as const satisfies Record<string, SystemAccount>

/** `2100-<providerId>`: the liability account holding what a provider is owed. */
export function providerPayableAccountCode(providerId: number): string {
  return `2100-${providerId}`
}

export function providerPayableAccountName(providerName: string): string {
  return `Payable to ${providerName}`
}

/** Which of a patient payment's four accounts a posting belongs to. */
export type PaymentJournalAccount =
  'cash' | 'product_sales' | 'provider_payable' | 'platform_fee'

/** Payable codes are `2100-<providerId>`; bare `2100` when the provider is unknown. */
const PAYABLE_CODE_PREFIX = '2100'

/** The payment line an account code is, or null for an unrelated account. */
export function paymentJournalAccountOf(
  accountCode: string,
): PaymentJournalAccount | null {
  if (accountCode === SYSTEM_ACCOUNTS.cash.code) return 'cash'
  if (accountCode === SYSTEM_ACCOUNTS.productSales.code) return 'product_sales'
  if (accountCode === SYSTEM_ACCOUNTS.platformFee.code) return 'platform_fee'
  if (
    accountCode === PAYABLE_CODE_PREFIX ||
    accountCode.startsWith(`${PAYABLE_CODE_PREFIX}-`)
  ) {
    return 'provider_payable'
  }
  return null
}

export interface PostingDraft {
  /** Set when the caller supplied the account's id. */
  accountId?: number
  accountCode: string
  /** Positive = debit, negative = credit; never 0. */
  amountCents: number
}

export interface PaymentJournalAccounts {
  cashAccountId?: number
  productSalesAccountId?: number
  platformFeeAccountId?: number
  providerAccountId?: number
  /** `2100-<providerId>`; defaults to `2100`. */
  providerAccountCode?: string
}

/**
 * The postings for a patient payment, in this order: Cash debit of the total,
 * then credits to product sales (cogs), the provider's payable (margin) and
 * platform fee revenue (fee). Zero amounts are omitted, so a zero-margin or
 * zero-fee order has fewer postings. A zero-total split has none and fails
 * assertJournalBalances.
 */
export function paymentJournal(
  split: OrderSplit,
  accounts: PaymentJournalAccounts = {},
): PostingDraft[] {
  const drafts: {
    accountId: number | undefined
    accountCode: string
    amountCents: number
  }[] = [
    {
      accountId: accounts.cashAccountId,
      accountCode: SYSTEM_ACCOUNTS.cash.code,
      amountCents: split.totalCents,
    },
    {
      accountId: accounts.productSalesAccountId,
      accountCode: SYSTEM_ACCOUNTS.productSales.code,
      amountCents: -split.cogsCents,
    },
    {
      accountId: accounts.providerAccountId,
      accountCode: accounts.providerAccountCode ?? PAYABLE_CODE_PREFIX,
      amountCents: -split.providerMarginCents,
    },
    {
      accountId: accounts.platformFeeAccountId,
      accountCode: SYSTEM_ACCOUNTS.platformFee.code,
      amountCents: -split.platformFeeCents,
    },
  ]
  return drafts
    .filter((draft) => draft.amountCents !== 0)
    .map(({ accountId, accountCode, amountCents }) =>
      accountId === undefined
        ? { accountCode, amountCents }
        : { accountId, accountCode, amountCents },
    )
}

/**
 * Throws LedgerImbalanceError (expected 0, actual = the sum) unless there are
 * at least 2 postings, each a non-zero safe integer, summing exactly to 0.
 */
export function assertJournalBalances(
  postings: readonly { amountCents: number }[],
): void {
  const actualCents = postings.reduce(
    (sum, posting) => sum + posting.amountCents,
    0,
  )
  const amountsAreValid = postings.every(
    (posting) =>
      Number.isSafeInteger(posting.amountCents) && posting.amountCents !== 0,
  )
  // Partial sums of safe integers stay exact while they are safe; a total past
  // MAX_SAFE_INTEGER in either direction could round to a false 0, so the debit
  // and credit sides are each required to be safe too.
  const debits = postings
    .filter((posting) => posting.amountCents > 0)
    .reduce((sum, posting) => sum + posting.amountCents, 0)
  const credits = postings
    .filter((posting) => posting.amountCents < 0)
    .reduce((sum, posting) => sum - posting.amountCents, 0)
  const sidesAreExact =
    Number.isSafeInteger(debits) && Number.isSafeInteger(credits)
  if (
    postings.length >= 2 &&
    amountsAreValid &&
    sidesAreExact &&
    debits === credits
  ) {
    return
  }
  throw new LedgerImbalanceError(0, actualCents)
}

export interface JournalSplit {
  cogsCents: number
  providerMarginCents: number
  platformFeeCents: number
  totalCents: number
}

/**
 * Reads a patient payment's split back from its postings, by account code:
 * total = the Cash debit, and each credit's magnitude for cogs, margin and
 * fee. An omitted posting means 0.
 */
export function splitFromPostings(
  postings: readonly Pick<PostingDraft, 'accountCode' | 'amountCents'>[],
): JournalSplit {
  const amountFor = (account: PaymentJournalAccount) =>
    postings
      .filter(
        (posting) => paymentJournalAccountOf(posting.accountCode) === account,
      )
      .reduce((sum, posting) => sum + posting.amountCents, 0)
  // `|| 0` turns the -0 of an omitted credit into 0.
  return {
    cogsCents: -amountFor('product_sales') || 0,
    providerMarginCents: -amountFor('provider_payable') || 0,
    platformFeeCents: -amountFor('platform_fee') || 0,
    totalCents: amountFor('cash'),
  }
}
