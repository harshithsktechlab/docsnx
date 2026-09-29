-- ═══════════════════════════════════════════════════════════════════════════
--  0028 — plan expiry notices: how far the reminder sequence has got.
--
--  An expiring subscription is now announced three times before it lapses
--  (T-7, T-3, T-1) and once on the day it does, on three channels at once —
--  the in-app bell, FCM push, and email. The job that sends them runs daily,
--  so without a marker it would resend the same notice every single day for as
--  long as a plan stayed expired.
--
--  `plan_notice_stage` records the last stage sent for the CURRENT term.
--  `applyPlanToTenant` (src/lib/planProvisioning.ts) clears both columns on
--  renewal, which re-arms the sequence for the new term.
--
--  PURELY ADDITIVE — two nullable columns on an existing table. Nothing is
--  dropped, renamed or backfilled; NULL reads as "nothing sent yet", which is
--  the correct state for every existing tenant.
--
--  No RLS change: `tenants` is not one of the tenant_id-scoped tables in
--  scripts/apply-rls.js — it IS the tenant.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan_notice_stage" varchar(16);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan_notice_sent_at" timestamp with time zone;
