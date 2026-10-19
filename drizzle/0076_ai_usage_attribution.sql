-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0076 — tenant_ai_usages: what each AI call was ABOUT, and final cost    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0075 made each row say who, which task, which key and what it cost. It still
-- could not say which DOCUMENT the call was for: at AI time the document does
-- not exist yet (Power Scan proposes records; uploads fill an unsaved form).
-- These columns are stamped at AI time (batch, category, size) and the
-- document / todo / contact id is linked afterwards, when the user saves — see
-- src/lib/aiUsageLink.ts. A row that is never linked is AI work the user threw
-- away, which the super admin AI Usage page reports as "Not saved".
--
-- `document_id` / `todo_id` / `contact_id` carry no FK, for the same reason
-- `document_holders.document_id` does not: it keeps `documents` partitionable,
-- and a usage row must survive the record it described being deleted.
--
-- Final cost: the platform's full cost of an AI call is the Gemini cost in INR
-- times `system_configs.ai_cost_multiplier` (2 for now, as set by the owner).
-- The multiplier in force is snapshotted on each row, like `usd_inr_rate`, so
-- changing the setting never rewrites past figures.
--
-- Additive only; rows written before this migration keep NULL.
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "document_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "todo_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "module_key" varchar(64);--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "document_key" varchar(100);--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "file_count" integer;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "page_count" integer;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "cost_multiplier" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD COLUMN IF NOT EXISTS "final_cost_inr" numeric(12, 4);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_ai_usages_document_idx" ON "tenant_ai_usages" ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_ai_usages_batch_idx" ON "tenant_ai_usages" ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_ai_usages_created_idx" ON "tenant_ai_usages" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_ai_usages_action_created_idx" ON "tenant_ai_usages" ("action", "created_at");--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "ai_cost_multiplier" numeric(6, 2) DEFAULT 2.00 NOT NULL;
