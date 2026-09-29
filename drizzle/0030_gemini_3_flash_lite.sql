-- ═══════════════════════════════════════════════════════════════════════════
--  0030 — move every AI key and tenant off the retired gemini-2.5-flash.
--
--  On 2026-08-18 Google began refusing the model outright:
--
--    {"error":{"code":404,"message":"This model models/gemini-2.5-flash is no
--     longer available to new users. Please update your code to use
--     models/gemini-3.6-flash ...","status":"NOT_FOUND"}}
--
--  Every AI feature in the platform stopped at once — bulk scan, autofill and
--  all three analysis actions — because the model id is read from these two
--  columns on every call (see buildClientFromKey and executeTenantWithRotation
--  in src/lib/aiKeyManager.ts).
--
--  CHANGING THE DEFAULT IS NOT ENOUGH. A column default only applies to rows
--  inserted after it, so the UPDATEs below are the half of this migration that
--  actually restores service. Every existing api_keys row and every tenant that
--  has ever been provisioned carries the literal string.
--
--  Target is gemini-3.1-flash-lite rather than the gemini-3.6-flash that
--  Google's own error suggests: it takes the same text/image/PDF input and
--  structured output that this codebase needs, at $0.25/$1.50 per 1M tokens
--  against 3.6 Flash's $0.75/$3.75. See src/lib/aiModels.ts, which is now the
--  single source of truth for model ids and their published rates — these two
--  defaults are the only legitimate duplicates of it, because Drizzle bakes a
--  default into the SQL and cannot read a TS constant.
--
--  SCOPED, NOT BLANKET. Both UPDATEs are guarded on the retired id, so a tenant
--  or key an admin has deliberately pointed at some other model is untouched.
--
--  NON-DESTRUCTIVE — two default changes and two guarded UPDATEs. No column is
--  dropped or renamed, and 'gemini-2.5-flash' stays selectable in the AI
--  Settings picker (labelled retired) so historical rows still render.
--
--  No RLS change: `api_keys` is platform-wide and `tenants` IS the tenant, so
--  neither is in scripts/apply-rls.js.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "tenants"  ALTER COLUMN "ai_model" SET DEFAULT 'gemini-3.1-flash-lite';
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "model"    SET DEFAULT 'gemini-3.1-flash-lite';
--> statement-breakpoint
UPDATE "tenants"  SET "ai_model" = 'gemini-3.1-flash-lite' WHERE "ai_model" = 'gemini-2.5-flash';
--> statement-breakpoint
UPDATE "api_keys" SET "model"    = 'gemini-3.1-flash-lite' WHERE "model"    = 'gemini-2.5-flash';
