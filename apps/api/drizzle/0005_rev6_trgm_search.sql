-- Substring search (ILIKE '%q%') on products.name, products.sku and users.name. pg_trgm ships with Postgres contrib and is available on managed hosts such as Neon, RDS and Cloud SQL.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_sku_trgm_idx" ON "products" USING gin ("sku" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_name_trgm_idx" ON "users" USING gin ("name" gin_trgm_ops);