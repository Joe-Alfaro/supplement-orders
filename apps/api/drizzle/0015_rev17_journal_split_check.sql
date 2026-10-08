-- Revision 17.3: the database checks each payment journal's split, not only
-- its balance, plus the payment's provenance. The checks move into
-- assert_payment_journal(payment_id) so this migration can run them over every
-- existing payment; check_payment_journal (the 0014 deferred trigger function)
-- now resolves the payment and calls it. Nothing is loosened: a row that fails
-- here fails the migration.
--
-- For a patient_payment journal, on top of 0014's linkage (exactly one journal
-- on the payment's order, Cash debit = the payment, only Cash, Product sales,
-- Platform fee revenue and the order's provider payable, credits negative):
--   * Product sales credit = sum(order_items.quantity * unit_cogs_cents),
--   * Platform fee revenue credit = orders.platform_fee_cents (every sent order
--     stores it, by orders_totals_present_once_sent, so there is no fallback),
--   * the order's provider payable credit = amount - cogs - fee,
-- each omitted when 0, and the payment's attempt is a succeeded attempt on the
-- same order.
CREATE FUNCTION assert_payment_journal(target_payment integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  paid record;
  journal_count integer;
  linked record;
  attempt record;
  item_count integer;
  missing_cogs integer;
  cogs_expected numeric;
  margin_expected numeric;
  posted record;
BEGIN
  SELECT p.id, p.order_id, p.amount_cents, p.payment_attempt_id,
         o.provider_id, o.platform_fee_cents
    INTO paid
    FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.id = target_payment;
  IF NOT FOUND THEN
    RETURN; -- the foreign key reports a missing payment
  END IF;

  -- Provenance: a succeeded attempt on the same order.
  IF paid.payment_attempt_id IS NULL THEN
    RAISE EXCEPTION 'payment % has no payment attempt', target_payment
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT order_id, status::text AS status INTO attempt
    FROM payment_attempts WHERE id = paid.payment_attempt_id;
  IF NOT FOUND OR attempt.order_id IS DISTINCT FROM paid.order_id OR attempt.status <> 'succeeded' THEN
    RAISE EXCEPTION 'payment % must come from a succeeded attempt on order % (attempt %: order %, status %)',
      target_payment, paid.order_id, paid.payment_attempt_id, attempt.order_id, attempt.status
      USING ERRCODE = 'integrity_constraint_violation';
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
      count(*) FILTER (WHERE a.code = '1000') AS cash_count,
      coalesce(sum(ps.amount_cents) FILTER (WHERE a.code = '1000'), 0) AS cash,
      coalesce(sum(ps.amount_cents) FILTER (WHERE a.code = '4000'), 0) AS cogs,
      coalesce(sum(ps.amount_cents) FILTER (WHERE a.code = '4100'), 0) AS fee,
      coalesce(sum(ps.amount_cents) FILTER (WHERE a.provider_id = paid.provider_id), 0) AS margin,
      count(*) FILTER (WHERE a.code NOT IN ('1000', '4000', '4100')
                         AND a.provider_id IS DISTINCT FROM paid.provider_id) AS foreign_count,
      count(*) FILTER (WHERE a.code <> '1000' AND ps.amount_cents > 0) AS debit_credit_count
    INTO posted
    FROM postings ps JOIN accounts a ON a.id = ps.account_id
    WHERE ps.journal_id = linked.id;

  IF posted.cash_count <> 1 OR posted.cash <> paid.amount_cents THEN
    RAISE EXCEPTION 'journal % must debit Cash exactly % for payment % (debits %)', linked.id, paid.amount_cents, target_payment, posted.cash
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF posted.foreign_count > 0 THEN
    RAISE EXCEPTION 'journal % posts to an account outside Cash, Product sales, Platform fee revenue and the payable of provider %', linked.id, paid.provider_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF posted.debit_credit_count > 0 THEN
    RAISE EXCEPTION 'journal % must only credit (negative amounts) accounts other than Cash', linked.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The split, from the order's own snapshots.
  SELECT count(*), count(*) FILTER (WHERE unit_cogs_cents IS NULL),
         coalesce(sum(quantity::numeric * unit_cogs_cents), 0)
    INTO item_count, missing_cogs, cogs_expected
    FROM order_items WHERE order_id = paid.order_id;
  IF item_count = 0 OR missing_cogs > 0 THEN
    RAISE EXCEPTION 'order % of payment % needs lines with wholesale cost snapshots (% lines, % without)', paid.order_id, target_payment, item_count, missing_cogs
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF -posted.cogs <> cogs_expected THEN
    RAISE EXCEPTION 'journal % credits Product sales % but order % lines cost %', linked.id, -posted.cogs, paid.order_id, cogs_expected
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF -posted.fee <> paid.platform_fee_cents THEN
    RAISE EXCEPTION 'journal % credits Platform fee revenue % but order % fee is %', linked.id, -posted.fee, paid.order_id, paid.platform_fee_cents
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  margin_expected := paid.amount_cents - cogs_expected - paid.platform_fee_cents;
  IF margin_expected < 0 OR -posted.margin <> margin_expected THEN
    RAISE EXCEPTION 'journal % credits provider % payable % but payment % less cost and fee is %', linked.id, paid.provider_id, -posted.margin, target_payment, margin_expected
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$$;--> statement-breakpoint

-- The 0014 trigger function keeps its name and triggers; only its body changes.
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
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

-- Existing data must pass: the first payment that does not aborts the migration.
SELECT assert_payment_journal(id) FROM (SELECT id FROM payments ORDER BY id) AS existing;
