-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0075 — tenant_ai_usages: full token detail, credits and INR cost        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `tenant_ai_usages` recorded only tenant, model, prompt/completion tokens and
-- a USD `cost`. It could not say which AI task a call was, who triggered it,
-- which key paid, how many credits it cost or what it cost in rupees — and it
-- under-reported Google's bill, because Gemini 3 thinking tokens (billed at the
-- output rate) were never captured.
--
-- Additive only. Nothing is renamed or dropped: `cost` stays the USD column the
-- admin screens already sum. Rows written before this migration keep NULL / 0
-- in the new columns — they are deliberately NOT backfilled.
--
-- `system_configs.usd_inr_rate` has no default on purpose: any built-in rate
-- would be a guess. Until a super admin sets it in Admin → AI Settings,
-- `cost_inr` is written as NULL.
--
-- RLS: tenant_ai_usages is already registered in scripts/apply-rls.js; adding
-- columns needs no policy change.
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "action" varchar(64);--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "thinking_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "cached_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "key_source" varchar(16);--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "credits_charged" integer;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "usd_inr_rate" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "cost_inr" numeric(12, 4);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_ai_usages_tenant_created_idx" ON "tenant_ai_usages" ("tenant_id", "created_at");--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "usd_inr_rate" numeric(10, 4);
