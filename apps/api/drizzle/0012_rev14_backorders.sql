ALTER TABLE "orders" ADD COLUMN "split_from_order_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "split_from_revision" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_split_from_order_id_orders_id_fk" FOREIGN KEY ("split_from_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_split_from_order_id_unique" ON "orders" USING btree ("split_from_order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_split_columns_together" CHECK (("orders"."split_from_order_id" is null) = ("orders"."split_from_revision" is null));--> statement-breakpoint

-- Revision 14 (DOMAIN_CONTRACT 14.3b): "awaiting stock" is derived, never
-- stored. A pending_payment order none of whose lines has a product with
-- stock_quantity > 0 reads as 'awaiting_stock'; every other order reads as its
-- stored status. Readers use this view; writes and row locks stay on orders,
-- and nothing updates order rows when stock changes.
CREATE VIEW "orders_with_status" AS
SELECT
  o.*,
  CASE
    WHEN o.status = 'pending_payment' AND NOT EXISTS (
      SELECT 1
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = o.id AND p.stock_quantity > 0
    ) THEN 'awaiting_stock'
    ELSE o.status::text
  END AS effective_status
FROM orders o;
