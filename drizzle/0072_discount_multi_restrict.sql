-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0072 — discount codes may be restricted to several plans / add-ons      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The admin modal now ticks any number of plans (Personal, Business,
-- Personal + Business) and add-ons. An empty array means "All" — no
-- restriction. The single plan_id / addon_id columns are backfilled into the
-- arrays and then left alone: nothing writes them any more.
ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "plan_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "addon_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE "discount_codes" SET "plan_ids" = ARRAY["plan_id"] WHERE "plan_id" IS NOT NULL AND cardinality("plan_ids") = 0;--> statement-breakpoint
UPDATE "discount_codes" SET "addon_ids" = ARRAY["addon_id"] WHERE "addon_id" IS NOT NULL AND cardinality("addon_ids") = 0;
