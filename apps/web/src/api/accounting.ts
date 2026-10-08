import type { Page, ProviderOrderDetailDto } from '@supplement-orders/domain'

// Revision 16 wire types (DOMAIN_CONTRACT 16.4). Defined here until the domain
// package exports them; then switch these imports to @supplement-orders/domain.

export type AccountType = 'asset' | 'liability' | 'revenue' | 'equity'

/** One posting; exactly one of debit and credit is set. */
export interface JournalPostingDto {
  accountCode: string
  accountName: string
  debitCents: number | null
  creditCents: number | null
}

export interface JournalDto {
  id: number
  postedAt: string
  memo: string
  postings: JournalPostingDto[]
}

/** A paid provider order carries the journal behind its split. */
export interface ProviderOrderJournalDto extends ProviderOrderDetailDto {
  /** Absent until the revision 16 API is merged; null before payment. */
  journal?: JournalDto | null
}

/** GET /api/dashboard also reports what the platform owes the provider. */
export interface OwedToYouDto {
  owedToYouCents?: number
}

export interface AccountBalanceDto {
  id: number
  code: string
  name: string
  type: AccountType
  debitsCents: number
  creditsCents: number
  /** Signed toward the account's normal balance. */
  balanceCents: number
}

export interface AdminAccountsDto {
  accounts: AccountBalanceDto[]
  totals: { debitsCents: number; creditsCents: number }
}

export interface AdminJournalDto extends JournalDto {
  orderId: number
  patientName: string
  providerName: string
}

export type AdminJournalPageDto = Page<AdminJournalDto>
