-- Revision 2. orders_total_is_subtotal is NOT VALID so revision-1 orders (fee on top)
-- already in a database stay as they were paid; every new or updated row is checked.
ALTER TABLE "orders" DROP CONSTRAINT "orders_total_is_subtotal_plus_fee";--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "unit_price_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "unit_cogs_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cogs_iff_product" CHECK (("order_items"."product_id" is null) = ("order_items"."unit_cogs_cents" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_is_subtotal" CHECK ("orders"."total_cents" is null or "orders"."total_cents" = "orders"."subtotal_cents") NOT VALID;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fee_within_subtotal" CHECK ("orders"."platform_fee_cents" is null or "orders"."platform_fee_cents" <= "orders"."subtotal_cents");