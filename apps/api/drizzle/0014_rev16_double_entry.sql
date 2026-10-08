-- Revision 16: the double-entry ledger replaces ledger_entries. Journals and
-- their postings (signed integer cents: positive = debit, negative = credit)
-- become the single source of truth for money. Row triggers do not fire on
-- TRUNCATE, so test, e2e and seed resets keep working (as with 0010 and 0013).

-- The 0010 payment-balance trigger checked ledger_entries; payments_journal_linked
-- below replaces it. The payments append-only trigger stays.
DROP TRIGGER "payments_ledger_balanced" ON "payments";--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'revenue', 'equity');--> statement-breakpoint
CREATE TYPE "public"."journal_kind" AS ENUM('patient_payment');--> statement-breakpoint
CREATE TYPE "public"."normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"normal_balance" "normal_balance" NOT NULL,
	"provider_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "accounts_provider_id_unique" UNIQUE("provider_id"),
	CONSTRAINT "accounts_normal_balance_matches_type" CHECK (("accounts"."type" = 'asset') = ("accounts"."normal_balance" = 'debit')),
	CONSTRAINT "accounts_provider_payable_is_liability" CHECK ("accounts"."provider_id" is null or "accounts"."type" = 'liability')
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "journal_kind" NOT NULL,
	"payment_id" integer,
	"order_id" integer,
	"memo" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "journals_patient_payment_links" CHECK ("journals"."kind" <> 'patient_payment' or ("journals"."payment_id" is not null and "journals"."order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"journal_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "postings_journal_account_unique" UNIQUE("journal_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journals_order_id_idx" ON "journals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "journals_posted_at_id_idx" ON "journals" USING btree ("posted_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "postings_account_id_idx" ON "postings" USING btree ("account_id");--> statement-breakpoint

-- Append-only. forbid_ledger_change (0010) now guards payments, journals and postings.
CREATE OR REPLACE FUNCTION forbid_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: payments, journals and postings are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();--> statement-breakpoint
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();--> statement-breakpoint

-- Accounts are append-only too, except that a rename is allowed (a payable
-- follows its provider's name).
CREATE FUNCTION forbid_account_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'name') = (to_jsonb(OLD) - 'name') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on account % is not allowed: accounts are append-only except for a rename', TG_OP, OLD.code
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER accounts_append_only BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_account_change();--> statement-breakpoint

-- Balanced at commit: every journal has at least 2 postings, none of them 0,
-- summing exactly to 0. Deferred so a journal and its postings can be written
-- in any order within one transaction.
CREATE FUNCTION check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_journal integer;
  posting_count integer;
  zero_count integer;
  posting_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN
    target_journal := NEW.id;
  ELSE
    target_journal := NEW.journal_id;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE amount_cents = 0), coalesce(sum(amount_cents), 0)
    INTO posting_count, zero_count, posting_total
    FROM postings WHERE journal_id = target_journal;

  IF zero_count > 0 THEN
    RAISE EXCEPTION 'journal % has a zero posting', target_journal
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'journal % must have at least 2 postings (has %)', target_journal, posting_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF posting_total <> 0 THEN
    RAISE EXCEPTION 'journal % postings sum to % instead of 0', target_journal, posting_total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();--> statement-breakpoint

-- Payment linkage at commit: every payment has exactly one patient_payment
-- journal on its order, posting only to Cash (a debit of exactly the payment
-- amount), Product sales, the order's provider payable and Platform fee
-- revenue, each credit negative. With the balance check, the credits sum to
-- the payment. Zero amounts are omitted, so a payment of 0 can never commit.
CREATE FUNCTION check_payment_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_payment integer;
  paid record;
  journal_count integer;
  linked record;
  cash_count integer;
  cash_total numeric;
  foreign_count integer;
  debit_credit_count integer;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    target_payment := NEW.id;
  ELSIF TG_TABLE_NAME = 'journals' THEN
    target_payment := NEW.payment_id;
  ELSE
    SELECT payment_id INTO target_payment FROM journals WHERE id = NEW.journal_id;
  END IF;
  IF target_payment IS NULL THEN
    RETURN NULL; -- not a payment journal
  END IF;

  SELECT p.id, p.order_id, p.amount_cents, o.provider_id INTO paid
    FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.id = target_payment;
  IF NOT FOUND THEN
    RETURN NULL; -- the foreign key reports a missing payment
  END IF;

  SELECT count(*) INTO journal_count
    FROM journals WHERE payment_id = target_payment AND kind = 'patient_payment';
  IF journal_count <> 1 THEN
    RAISE EXCEPTION 'payment % must have exactly one patient_payment journal (has %)', target_payment, journal_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT id, order_id INTO linked FROM journals WHERE payment_id = target_payment;
  IF linked.order_id IS DISTINCT FROM paid.order_id THEN
    RAISE EXCEPTION 'journal % is on order % but payment % is on order %', linked.id, linked.order_id, target_payment, paid.order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT
      count(*) FILTER (WHERE a.code = '1000'),
      coalesce(sum(ps.amount_cents) FILTER (WHERE a.code = '1000'), 0),
      count(*) FILTER (WHERE a.code NOT IN ('1000', '4000', '4100')
                         AND a.provider_id IS DISTINCT FROM paid.provider_id),
      count(*) FILTER (WHERE a.code <> '1000' AND ps.amount_cents > 0)
    INTO cash_count, cash_total, foreign_count, debit_credit_count
    FROM postings ps JOIN accounts a ON a.id = ps.account_id
    WHERE ps.journal_id = linked.id;

  IF cash_count <> 1 OR cash_total <> paid.amount_cents THEN
    RAISE EXCEPTION 'journal % must debit Cash exactly % for payment % (debits %)', linked.id, paid.amount_cents, target_payment, cash_total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF foreign_count > 0 THEN
    RAISE EXCEPTION 'journal % posts to an account outside Cash, Product sales, Platform fee revenue and the payable of provider %', linked.id, paid.provider_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF debit_credit_count > 0 THEN
    RAISE EXCEPTION 'journal % must only credit (negative amounts) accounts other than Cash', linked.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_journal_linked AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_journal();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journals_payment_linked AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_journal();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER postings_payment_linked AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_journal();--> statement-breakpoint

-- Every provider gets its payable account in the same statement that creates
-- it, whatever the create path, and the account follows the provider's name.
CREATE FUNCTION create_provider_payable_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO accounts (code, name, type, normal_balance, provider_id)
    SELECT '2100-' || NEW.id, 'Payable to ' || u.name, 'liability', 'credit', NEW.id
    FROM users u WHERE u.id = NEW.user_id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER providers_payable_account AFTER INSERT ON providers
  FOR EACH ROW EXECUTE FUNCTION create_provider_payable_account();--> statement-breakpoint
CREATE FUNCTION rename_provider_payable_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts a SET name = 'Payable to ' || NEW.name
    FROM providers p
    WHERE p.user_id = NEW.id AND a.provider_id = p.id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER users_rename_payable_account AFTER UPDATE OF name ON users
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION rename_provider_payable_account();--> statement-breakpoint

-- System accounts, then one payable per existing provider (in id order).
INSERT INTO accounts (code, name, type, normal_balance) VALUES
  ('1000', 'Cash', 'asset', 'debit'),
  ('4000', 'Product sales at wholesale cost', 'revenue', 'credit'),
  ('4100', 'Platform fee revenue', 'revenue', 'credit');--> statement-breakpoint
INSERT INTO accounts (code, name, type, normal_balance, provider_id)
  SELECT '2100-' || p.id, 'Payable to ' || u.name, 'liability', 'credit', p.id
  FROM providers p JOIN users u ON u.id = p.user_id
  ORDER BY p.id;--> statement-breakpoint

-- Backfill: each payment and its three ledger rows become one journal. The Cash
-- debit is the payment amount; the credits are the cogs, margin and fee rows,
-- with zero amounts omitted.
INSERT INTO journals (kind, payment_id, order_id, memo, posted_at)
  SELECT 'patient_payment', p.id, p.order_id, 'Patient payment for order #' || p.order_id, p.created_at
  FROM payments p
  ORDER BY p.id;--> statement-breakpoint
INSERT INTO postings (journal_id, account_id, amount_cents)
  SELECT j.id, a.id, x.amount_cents
  FROM journals j
  JOIN payments p ON p.id = j.payment_id
  JOIN orders o ON o.id = p.order_id
  CROSS JOIN LATERAL (VALUES
    (1, '1000', p.amount_cents),
    (2, '4000', -(SELECT amount_cents FROM ledger_entries WHERE payment_id = p.id AND type = 'cogs')),
    (3, '2100-' || o.provider_id, -(SELECT amount_cents FROM ledger_entries WHERE payment_id = p.id AND type = 'provider_margin')),
    (4, '4100', -(SELECT amount_cents FROM ledger_entries WHERE payment_id = p.id AND type = 'platform_fee'))
  ) AS x(position, code, amount_cents)
  JOIN accounts a ON a.code = x.code
  WHERE x.amount_cents IS DISTINCT FROM 0
  ORDER BY j.id, x.position;--> statement-breakpoint

-- Check the backfill now, before ledger_entries is gone, rather than at the end
-- of the migration transaction.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint

DROP TABLE "ledger_entries" CASCADE;--> statement-breakpoint
DROP FUNCTION check_payment_ledger_balanced();--> statement-breakpoint
DROP TYPE "public"."ledger_entry_type";
