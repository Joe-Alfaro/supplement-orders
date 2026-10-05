-- Revision 3b. Existing patients get a deterministic placeholder date of birth
-- derived from their id (1936-01-01 plus up to ~71 years, so ages ~18-90 in
-- 2026) before the column becomes NOT NULL. `npm run db:seed` replaces them.
ALTER TABLE "patients" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
UPDATE "patients" SET "date_of_birth" = DATE '1936-01-01' + (("id" * 7919) % 26000);--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "date_of_birth" SET NOT NULL;
