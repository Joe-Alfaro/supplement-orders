-- Revision 9: quote revisions and durable payment attempts (Codex audit H1, H2).
CREATE TYPE "public"."payment_attempt_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'pending' NOT NULL,
	"gateway_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_attempts_order_revision_unique" UNIQUE("order_id","revision"),
	CONSTRAINT "payment_attempts_amount_nonnegative" CHECK ("payment_attempts"."amount_cents" >= 0),
	CONSTRAINT "payment_attempts_reference_iff_succeeded" CHECK (("payment_attempts"."status" = 'succeeded') = ("payment_attempts"."gateway_reference" is not null))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_attempt_id" integer;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_attempt_id_unique" UNIQUE("payment_attempt_id");--> statement-breakpoint
-- Every order already sent counts as its first revision; drafts stay at 0.
UPDATE "orders" SET "revision" = 1 WHERE "sent_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_revision_counts_sends" CHECK ("orders"."revision" >= 0 and ("orders"."sent_at" is null or "orders"."revision" >= 1));