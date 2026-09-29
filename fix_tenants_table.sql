ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_name" varchar(255);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_gst" varchar(50);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_address" text;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "ai_credits_balance" integer DEFAULT 0;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "has_completed_onboarding" boolean DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "amc_last_paid_at" timestamp;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "amc_next_due_date" timestamp;
