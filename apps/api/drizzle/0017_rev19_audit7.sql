-- Revision 19 (audit 7).
--
-- 19.1: an abandoned attempt's key is never retired, so a delayed gateway call
-- and a retry share one key and charge at most once. A success the gateway
-- reports for an execution that is no longer current is kept as late_success,
-- with its reference, until an admin reconciles it: it pays the order, or it
-- becomes refund_required and is later marked refunded. The new enum values
-- are compared as text below, because they are added in this transaction.
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'late_success';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_required';--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_reference_iff_succeeded";--> statement-breakpoint
ALTER TABLE "fake_gateway_charges" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "refunded_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_refunded_by_user_id_users_id_fk" FOREIGN KEY ("refunded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fake_gateway_charges" ADD CONSTRAINT "fake_gateway_charges_refunded_only_succeeded" CHECK ("fake_gateway_charges"."refunded_at" is null or "fake_gateway_charges"."status" = 'succeeded');--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_reference_iff_charged" CHECK (("payment_attempts"."status"::text in ('succeeded', 'late_success', 'refund_required')) = ("payment_attempts"."gateway_reference" is not null));--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_refunded_only_refund_required" CHECK ("payment_attempts"."refunded_at" is null or "payment_attempts"."status"::text = 'refund_required');--> statement-breakpoint

-- 19.2: a payment's provenance matches its attempt exactly. At commit, with
-- the other payment checks (0014, 0015), its amount, idempotency key and
-- gateway reference must equal the attempt's, and the attempt's revision must
-- equal the paid order's revision. A payment without an attempt is reported
-- by assert_payment_journal.
CREATE FUNCTION assert_payment_provenance(target_payment integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  paid record;
BEGIN
  SELECT p.amount_cents, p.idempotency_key, p.gateway_reference,
         a.id AS attempt_id, a.amount_cents AS attempt_amount,
         a.idempotency_key AS attempt_key,
         a.gateway_reference AS attempt_reference,
         a.revision AS attempt_revision, o.revision AS order_revision
    INTO paid
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    LEFT JOIN payment_attempts a ON a.id = p.payment_attempt_id
    WHERE p.id = target_payment;
  IF NOT FOUND OR paid.attempt_id IS NULL THEN
    RETURN;
  END IF;
  IF paid.amount_cents <> paid.attempt_amount
     OR paid.idempotency_key IS DISTINCT FROM paid.attempt_key
     OR paid.gateway_reference IS DISTINCT FROM paid.attempt_reference THEN
    RAISE EXCEPTION 'payment % (amount %, key %, reference %) must match its attempt % (amount %, key %, reference %)',
      target_payment, paid.amount_cents, paid.idempotency_key, paid.gateway_reference,
      paid.attempt_id, paid.attempt_amount, paid.attempt_key, paid.attempt_reference
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF paid.attempt_revision <> paid.order_revision THEN
    RAISE EXCEPTION 'payment % comes from attempt % for revision %, but the order is at revision %',
      target_payment, paid.attempt_id, paid.attempt_revision, paid.order_revision
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$$;--> statement-breakpoint

-- The 0014 trigger function keeps its name and triggers; it now runs both checks.
CREATE OR REPLACE FUNCTION check_payment_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_payment integer;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    target_payment := NEW.id;
  ELSIF TG_TABLE_NAME = 'journals' THEN
    target_payment := NEW.payment_id;
  ELSE
    SELECT payment_id INTO target_payment FROM journals WHERE id = NEW.journal_id;
  END IF;
  IF target_payment IS NOT NULL THEN
    PERFORM assert_payment_journal(target_payment);
    PERFORM assert_payment_provenance(target_payment);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

-- Existing data must pass: the first payment that does not aborts the migration.
SELECT assert_payment_provenance(id) FROM (SELECT id FROM payments ORDER BY id) AS existing;
