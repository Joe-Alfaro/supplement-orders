CREATE TABLE "provider_product_prices" (
	"provider_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_product_prices_provider_product_unique" UNIQUE("provider_id","product_id"),
	CONSTRAINT "provider_product_prices_range" CHECK ("provider_product_prices"."unit_price_cents" between 1 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "provider_product_prices" ADD CONSTRAINT "provider_product_prices_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_product_prices" ADD CONSTRAINT "provider_product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Revision 20.1: every provider has a default patient price for every product,
-- starting at the minimum unit price (the same integer arithmetic as the
-- domain's minUnitPriceCents: c + ceil(75c / 9925)), and at least 1 cent.
CREATE FUNCTION min_default_price_cents(cogs bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT greatest(1, cogs + (cogs * 75 + 9924) / 9925)
$$;--> statement-breakpoint

INSERT INTO "provider_product_prices" ("provider_id", "product_id", "unit_price_cents")
SELECT pr.id, p.id, min_default_price_cents(p.cogs_cents)
FROM "providers" pr CROSS JOIN "products" p;--> statement-breakpoint

-- A new provider gets a default for every product, a new product one for every
-- provider, so no creation path (seed, fixture, future admin tool) can miss one.
CREATE FUNCTION create_provider_default_prices() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO provider_product_prices (provider_id, product_id, unit_price_cents)
  SELECT NEW.id, p.id, min_default_price_cents(p.cogs_cents) FROM products p;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER providers_default_prices AFTER INSERT ON providers
  FOR EACH ROW EXECUTE FUNCTION create_provider_default_prices();--> statement-breakpoint

CREATE FUNCTION create_product_default_prices() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO provider_product_prices (provider_id, product_id, unit_price_cents)
  SELECT pr.id, NEW.id, min_default_price_cents(NEW.cogs_cents) FROM providers pr;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER products_default_prices AFTER INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION create_product_default_prices();
