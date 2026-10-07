-- Revision 9 follow-up: payment attempts reserve stock before the charge.
ALTER TABLE "payment_attempts" ADD COLUMN "stock_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Attempts already completed by a payment took their stock when it was recorded.
UPDATE "payment_attempts" SET "stock_held" = true WHERE "id" IN (SELECT "payment_attempt_id" FROM "payments" WHERE "payment_attempt_id" IS NOT NULL);
