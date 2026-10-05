CREATE INDEX "patients_provider_id_idx" ON "patients" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "products_name_id_idx" ON "products" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "products_lower_name_idx" ON "products" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "users_name_id_idx" ON "users" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "users_lower_name_idx" ON "users" USING btree (lower("name"));