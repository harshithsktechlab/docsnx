-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0059 — the bell learns which workspace it is ringing for                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0050–0057 taught every surface that holds or describes data the personal /
-- business split. The notification stack was the one left behind, and it failed
-- in three ways at once:
--
--   1. `notifications` carried `tenant_id` and `user_id` and nothing else, so
--      one undifferentiated badge counted the household and every company, and
--      "Mark all read" in Personal silently cleared Acme's unread.
--   2. The follow-up pass only ever walked the household vault, so a company's
--      licence or GST registration lapsing produced no notice at all.
--   3. `plan_notice_stage` is ONE column, and `business_plan_expiry` (0057) had
--      no ladder, so the business half locked at T-0 with no warning.
--
-- (2) is code alone. (1) and (3) need these columns.

-- ═══════════════════════════════════════════════════════════════════════════
--   1. A NOTICE BELONGS TO A WORKSPACE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Same pair `todos` and `emergency_contacts` took in 0053, and ON DELETE
-- RESTRICT for the same reason: removing a company must never silently take
-- rows with it. `WORKSPACE_TABLES` (src/lib/account/workspaceErasure.ts) deletes
-- a workspace's notices deliberately, before the company row goes.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "account_scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

-- ── WHY THIS CHECK IS NOT THE ONE IN 0053 ──────────────────────────────────
--
-- There the two columns are strict mirrors: 'personal' with no company,
-- 'business' with one. Here a THIRD value is legal — 'account', with no company
-- — and it is load-bearing rather than a loophole.
--
-- 'account' marks a notice that must be reachable from EVERY workspace, and only
-- the two billing ladders file one. The bell is scoped to the workspace you are
-- standing in, and the one message that explains why a workspace locked must not
-- be scoped out of the place you are standing when you go looking for it. A
-- business-plan notice also has no company to be filed under, and calling it
-- 'business' would hide it from the TENANT_ADMIN working in Personal — the only
-- person who can actually pay it.
--
-- What the CHECK still forbids is the pair disagreeing: 'personal' or 'account'
-- with a company attached, or 'business' without one.
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_account_scope_ck";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_scope_ck" CHECK (
  ("account_scope" = 'personal' AND "company_id" IS NULL) OR
  ("account_scope" = 'business' AND "company_id" IS NOT NULL) OR
  ("account_scope" = 'account'  AND "company_id" IS NULL)
);--> statement-breakpoint

-- The bell's own query: one recipient's rows in one workspace. Leads with
-- tenant_id like every other index on a tenant-scoped table, then the recipient,
-- because a notification is always read one member at a time.
CREATE INDEX IF NOT EXISTS "notifications_tenant_user_company_idx"
  ON "notifications" ("tenant_id", "user_id", "company_id");--> statement-breakpoint

-- ── EXISTING ROWS ──────────────────────────────────────────────────────────
--
-- The DEFAULT above already calls every existing row 'personal', which is what
-- they are: nothing has ever been able to file a business notice. The plan
-- notices among them are the exception — they are account-level and always were,
-- the column just did not exist to say so. Identified by their link rather than
-- by a type column, because there is no type column and these two links are
-- written by exactly one producer (src/lib/planNotifications.ts).
UPDATE "notifications"
   SET "account_scope" = 'account'
 WHERE "company_id" IS NULL
   AND ("link" = '/billing' OR "link" = '/billing/expired');--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   2. THE BUSINESS AXIS GETS ITS OWN REMINDER LADDER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `plan_notice_stage` counts down `subscription_expiry`, which since 0057 means
-- the HOUSEHOLD's plan alone. Reusing it for the business half would not merely
-- be untidy — the stages only move forward within a term (`stageAlreadySent`),
-- so a household plan sitting at 'EXPIRED' would swallow every business notice
-- behind it and the company's plan would lapse with nothing said.
--
-- Deliberately NOT back-filled. NULL means "no notice sent for this term", which
-- is exactly true: no business notice has ever been sent. A tenant whose
-- business plan is already inside its window is told at the next daily run,
-- which is the outcome we want rather than one to suppress.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "business_plan_notice_stage" varchar(16),
  ADD COLUMN IF NOT EXISTS "business_plan_notice_sent_at" timestamp with time zone;
