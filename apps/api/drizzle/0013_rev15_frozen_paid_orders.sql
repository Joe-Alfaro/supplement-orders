-- Revision 15.5 (audit 4, L1): every line keeps the product name and SKU it was
-- sold under. Saved with the line, refreshed on send, copied to back-orders;
-- sent and paid orders read the snapshot, never the live product.
ALTER TABLE "order_items" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "product_sku" text;--> statement-breakpoint
UPDATE "order_items" oi SET "product_name" = p."name", "product_sku" = p."sku"
  FROM "products" p WHERE p."id" = oi."product_id";--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_snapshot_iff_product" CHECK (("order_items"."product_id" is null) = ("order_items"."product_name" is null) and ("order_items"."product_id" is null) = ("order_items"."product_sku" is null));--> statement-breakpoint

-- Revision 15.1 (audit 4, H1): an order whose unresolved payment attempt holds
-- stock already has its units, so it is never awaiting_stock, even when the
-- reservation took the last unit. Otherwise as migration 0012.
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

-- Revision 15.5: a paid order is frozen. Only updated_at may change on its row,
-- it can't be deleted, and its lines can't be inserted, updated or deleted.
-- Row triggers do not fire on TRUNCATE, so test, e2e and seed resets keep
-- working (as with migration 0010).
CREATE FUNCTION forbid_paid_order_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'paid' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% of paid order % is not allowed: paid orders are frozen', TG_OP, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER orders_paid_frozen BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION forbid_paid_order_change();--> statement-breakpoint

CREATE FUNCTION forbid_paid_order_item_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM orders WHERE id = OLD.order_id AND status = 'paid'))
    OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM orders WHERE id = NEW.order_id AND status = 'paid')) THEN
    RAISE EXCEPTION '% on order_items of a paid order is not allowed: paid orders are frozen', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER order_items_paid_frozen BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION forbid_paid_order_item_change();
