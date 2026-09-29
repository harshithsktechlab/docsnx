-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0054 — an analysis belongs to the workspace it analysed                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `ai_analysis_cache` is keyed (tenant_id, user_id, category). That was total
-- while analysis was a personal feature: one household, one member, one module
-- is one answer.
--
-- A company workspace breaks it. Two companies in the same tenant both analyse
-- `biz_licenses`, and with no company on the key the second read returns the
-- FIRST company's summarised records — and the second write overwrites them.
-- That is one company's paperwork shown to another inside one tenant, which is
-- the one thing the business account exists to keep apart.
--
-- So the key gains its missing axis. Existing rows are all personal analyses
-- and stay NULL, which is exactly what they are.
--
-- No `account_scope` mirror here, unlike 0050 §4 and 0053. That column exists on
-- the record tables so a query can filter on whichever half it has in hand, and
-- the CHECK keeps the pair honest. This is a CACHE: nothing filters it by scope,
-- nothing joins it, and a second column to keep in step would be two things to
-- remember for no read that wants them.

-- ON DELETE RESTRICT, matching the record tables: removing a company must never
-- silently take rows with it. A stale cache row is trivially re-derivable, but
-- the failure mode of CASCADE is a delete that succeeds quietly and the failure
-- mode of RESTRICT is an error someone reads.
ALTER TABLE "ai_analysis_cache"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- Serves the only query this table has: one member's cached answer for one
-- module in one workspace. Leads with tenant_id like every other index on a
-- tenant-scoped table.
CREATE INDEX IF NOT EXISTS "ai_analysis_cache_tenant_company_idx"
  ON "ai_analysis_cache" ("tenant_id", "company_id");--> statement-breakpoint
