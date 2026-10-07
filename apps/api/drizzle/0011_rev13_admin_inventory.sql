-- Revision 13: a third role, admin, manages available stock, and every admin
-- stock change is audited in inventory_adjustments. ADD VALUE runs inside the
-- migration transaction, which Postgres allows as long as nothing here uses
-- 'admin'; the seed inserts the admin afterwards.
CREATE TYPE "public"."inventory_adjustment_kind" AS ENUM('increment', 'set');--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'admin';--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"kind" "inventory_adjustment_kind" NOT NULL,
	"previous_quantity" integer NOT NULL,
	"new_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_adjustments_quantities_nonnegative" CHECK ("inventory_adjustments"."previous_quantity" >= 0 and "inventory_adjustments"."new_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_adjustments_product_id_idx" ON "inventory_adjustments" USING btree ("product_id");--> statement-breakpoint

-- Append-only, like the ledger (migration 0010). Row triggers do not fire on
-- TRUNCATE, so test, e2e and seed resets keep working.
CREATE FUNCTION forbid_inventory_adjustment_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on inventory_adjustments is not allowed: the stock audit is append-only', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER inventory_adjustments_append_only BEFORE UPDATE OR DELETE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_inventory_adjustment_change();
