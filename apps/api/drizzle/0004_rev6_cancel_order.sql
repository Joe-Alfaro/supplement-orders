ALTER TABLE "orders" DROP CONSTRAINT "orders_totals_present_once_sent";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_provider_status_sent_idx" ON "orders" USING btree ("provider_id","status","sent_at","id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_sent_unless_draft_or_cancelled" CHECK ("orders"."status" in ('draft', 'cancelled') or "orders"."sent_at" is not null);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_at_iff_cancelled" CHECK (("orders"."status" = 'cancelled') = ("orders"."cancelled_at" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_totals_present_once_sent" CHECK ("orders"."sent_at" is null or ("orders"."subtotal_cents" is not null and "orders"."platform_fee_cents" is not null and "orders"."total_cents" is not null));