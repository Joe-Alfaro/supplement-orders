-- Revision 11b (audit L1): the database itself keeps the ledger append-only and
-- balanced, so it no longer depends only on application discipline. Row triggers
-- do not fire on TRUNCATE, so test, e2e and seed resets keep working.

-- Append-only: payments and ledger entries are never updated or deleted.
CREATE FUNCTION forbid_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: payments and ledger entries are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();--> statement-breakpoint

-- Balanced at commit: a payment must have exactly one cogs, one provider_margin
-- and one platform_fee entry, on the payment's order, summing exactly (numeric)
-- to the payment amount. Deferred so the payment and its entries can be written
-- in either order within one transaction.
CREATE FUNCTION check_payment_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_payment integer;
  paid record;
  entry_count integer;
  type_count integer;
  entry_total numeric;
  wrong_order integer;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    target_payment := NEW.id;
  ELSE
    target_payment := NEW.payment_id;
  END IF;

  SELECT id, order_id, amount_cents INTO paid FROM payments WHERE id = target_payment;
  IF NOT FOUND THEN
    RETURN NULL; -- the foreign key reports a missing payment
  END IF;

  SELECT count(*), count(DISTINCT type), coalesce(sum(amount_cents), 0),
         count(*) FILTER (WHERE order_id <> paid.order_id)
    INTO entry_count, type_count, entry_total, wrong_order
    FROM ledger_entries WHERE payment_id = target_payment;

  IF entry_count <> 3 OR type_count <> 3 THEN
    RAISE EXCEPTION 'payment % must have exactly one cogs, provider_margin and platform_fee entry (has %)', target_payment, entry_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF wrong_order > 0 THEN
    RAISE EXCEPTION 'payment % has ledger entries on another order than order %', target_payment, paid.order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF entry_total <> paid.amount_cents THEN
    RAISE EXCEPTION 'payment % entries sum to % but the payment is %', target_payment, entry_total, paid.amount_cents
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_ledger_balanced AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_ledger_balanced();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_ledger_balanced();
