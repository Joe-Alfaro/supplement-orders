-- Revision 10: execution-safe payments (Codex re-audit N1-N3). Existing attempts
-- become execution 1 (the column default) and keep their keys.
CREATE TYPE "public"."fake_gateway_charge_status" AS ENUM('succeeded', 'declined');--> statement-breakpoint
CREATE TABLE "fake_gateway_charges" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "fake_gateway_charge_status" NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fake_gateway_charges_reference_unique" UNIQUE("reference"),
	CONSTRAINT "fake_gateway_charges_reference_iff_succeeded" CHECK (("fake_gateway_charges"."status" = 'succeeded') = ("fake_gateway_charges"."reference" is not null)),
	CONSTRAINT "fake_gateway_charges_amount_nonnegative" CHECK ("fake_gateway_charges"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_order_revision_unique";--> statement-breakpoint
-- This CHECK compares status with an enum literal; drop it across the type swap.
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_reference_iff_succeeded";--> statement-breakpoint
ALTER TABLE "payment_attempts" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
-- Revision 9 called a declined attempt "failed"; revision 10 names it declined.
UPDATE "payment_attempts" SET "status" = 'declined' WHERE "status" = 'failed';--> statement-breakpoint
DROP TYPE "public"."payment_attempt_status";--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('pending', 'succeeded', 'declined', 'conflict');--> statement-breakpoint
ALTER TABLE "payment_attempts" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."payment_attempt_status";--> statement-breakpoint
ALTER TABLE "payment_attempts" ALTER COLUMN "status" SET DATA TYPE "public"."payment_attempt_status" USING "status"::"public"."payment_attempt_status";--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_reference_iff_succeeded" CHECK (("payment_attempts"."status" = 'succeeded') = ("payment_attempts"."gateway_reference" is not null));--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "execution" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_revision_execution_unique" UNIQUE("order_id","revision","execution");--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_execution_positive" CHECK ("payment_attempts"."execution" >= 1);--> statement-breakpoint
-- Seed the durable fake gateway with every success the app already knows about,
-- so lookup can verify them: succeeded attempts, then payments made before attempts existed.
INSERT INTO "fake_gateway_charges" ("idempotency_key", "amount_cents", "status", "reference")
SELECT "idempotency_key", "amount_cents", 'succeeded', "gateway_reference" FROM "payment_attempts" WHERE "status" = 'succeeded'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "fake_gateway_charges" ("idempotency_key", "amount_cents", "status", "reference")
SELECT "idempotency_key", "amount_cents", 'succeeded', "gateway_reference" FROM "payments" WHERE "payment_attempt_id" IS NULL
ON CONFLICT DO NOTHING;
