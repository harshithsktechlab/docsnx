ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "platform_name" varchar(255);
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "platform_gstin" varchar(50);
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "platform_address" text;

ALTER TABLE "investments" ADD COLUMN IF NOT EXISTS "property_tax_due_date" timestamp;
ALTER TABLE "investments" ADD COLUMN IF NOT EXISTS "property_tax_receipt_uploaded" boolean DEFAULT false;
ALTER TABLE "investments" ADD COLUMN IF NOT EXISTS "has_712_extract" boolean DEFAULT false;
ALTER TABLE "investments" ADD COLUMN IF NOT EXISTS "has_namuna_d" boolean DEFAULT false;
ALTER TABLE "investments" ADD COLUMN IF NOT EXISTS "has_map" boolean DEFAULT false;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consent_data_processing" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consent_timestamp" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consent_ip_address" varchar(45);

ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "is_lifetime" boolean DEFAULT false NOT NULL;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "amc_amount" decimal(12, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "ai_credits" integer DEFAULT 0 NOT NULL;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "max_family_members" integer DEFAULT 1 NOT NULL;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "storage_limit_gb" integer DEFAULT 1 NOT NULL;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "badge_color" varchar(50) DEFAULT 'secondary' NOT NULL;

ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "max_uses_per_tenant" integer;
ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "billing_cycle" varchar(50);
