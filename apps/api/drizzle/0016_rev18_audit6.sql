-- Revision 18 (audit 6).
--
-- 18.2: an admin can reconcile a stranded payment attempt. A pending attempt
-- the gateway never saw is marked abandoned after the safety window and its
-- stock released; that release is recorded in inventory_adjustments as
-- reconcile_release, naming the attempt. The new enum values are only used
-- by later transactions, as Postgres requires.
ALTER TYPE "public"."inventory_adjustment_kind" ADD VALUE 'reconcile_release';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE 'abandoned';--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "payment_attempt_id" integer;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "reconciled_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 18.4 (L4): each installation has its own UUID, generated here, which
-- prefixes every new idempotency key. Keys of existing attempts are unchanged.
CREATE TABLE "installation" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"install_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_singleton" CHECK ("installation"."singleton")
);
--> statement-breakpoint
INSERT INTO "installation" DEFAULT VALUES;--> statement-breakpoint

-- 18.1: only a live back-order counts. An order has at most one direct
-- back-order that is not cancelled; cancelled ones stay as history, so a
-- reopened and resent order can split again.
DROP INDEX "orders_split_from_order_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_split_from_order_id_live_unique" ON "orders" USING btree ("split_from_order_id") WHERE "orders"."status" <> 'cancelled';--> statement-breakpoint
-- Set on a cancelled back-order whose lines were merged back into the order it
-- was split from when that order was reopened, so they merge only once.
ALTER TABLE "orders" ADD COLUMN "merged_back_at" timestamp with time zone;--> statement-breakpoint

-- orders_with_status selects o.*, so it is recreated to carry the new column.
-- Otherwise exactly as migration 0013.
DROP VIEW "orders_with_status";--> statement-breakpoint
CREATE VIEW "orders_with_status" AS
SELECT
  o.*,
  CASE
    WHEN o.status = 'pending_payment' AND NOT EXISTS (
      SELECT 1
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = o.id AND p.stock_quantity > 0
    ) AND NOT EXISTS (
      SELECT 1
      FROM payment_attempts pa
      WHERE pa.order_id = o.id
        AND pa.stock_held
        AND pa.status IN ('pending', 'succeeded', 'conflict')
    ) THEN 'awaiting_stock'
    ELSE o.status::text
  END AS effective_status
FROM orders o;--> statement-breakpoint

-- 18.4 (L7): an attempt a payment references is frozen, like a paid order
-- (migration 0013): only updated_at may change, and it can't be deleted.
-- TRUNCATE-based test, seed and e2e resets bypass row triggers as before.
CREATE FUNCTION forbid_paid_attempt_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payments WHERE payment_attempt_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% of payment attempt % is not allowed: it is recorded by a payment', TG_OP, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER payment_attempts_paid_frozen BEFORE UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_paid_attempt_change();
