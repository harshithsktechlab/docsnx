-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0057 — billing, credits and the audit trail learn the account axis      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Everything that holds RECORDS was split personal/business across 0050–0056.
-- Everything that describes the ACCOUNT was not: one plan, one expiry, one
-- payment history, one flat credit ledger and one flat audit trail for a tenant
-- that may be running a household and three companies at once.
--
-- This migration gives each of those the axis it was missing. Three separate
-- ideas, deliberately kept apart because they resolve differently:
--
--   1. BILLING splits into two AXES — personal and business — and not per
--      company. A plan declares which half it covers and carries the quotas for
--      it; companies are capped BY the business plan rather than billed
--      individually.
--   2. THE CREDIT LEDGER gains a company only for ATTRIBUTION. There is still
--      exactly one wallet.
--   3. THE AUDIT TRAIL gains a company so each workspace has its own history.
--
-- Note the FK actions below differ table by table and each difference is
-- load-bearing. Read the comment before copying one.

-- ═══════════════════════════════════════════════════════════════════════════
--   1. A PLAN DECLARES WHICH ACCOUNT IT COVERS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `applies_to` is the plan's axis: 'personal', 'business', or 'both'. A 'both'
-- plan satisfies each side at once and appears in each billing tab.
--
-- DEFAULT 'personal' is not a neutral choice, it is the correct one: every plan
-- that exists today was sold to a household, and every tenant holding one has
-- it in `subscription_plan_id`, which becomes the personal axis below. Any other
-- default would silently re-describe live subscriptions.
--
-- `max_members` keeps its meaning — PERSONAL members — so no reader of it has to
-- change on the day this lands. The business side gets its own two counters.
--
-- ⚠ `max_members_per_company` is PER COMPANY and not a business-wide pool, and
-- the name is load-bearing. A business plan sells "N companies, M members in
-- each", so a tenant on 3×10 may hold thirty employees in total and still be
-- refused an eleventh on one of them. Called `max_business_members` it would be
-- read as a tenant-wide total by everyone who met it, which is a different
-- product with the same number in it.
ALTER TABLE "subscription_plans"
  ADD COLUMN IF NOT EXISTS "applies_to" varchar(16) DEFAULT 'personal' NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_members_per_company" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_companies" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "subscription_plans" DROP CONSTRAINT IF EXISTS "subscription_plans_applies_to_ck";--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_applies_to_ck" CHECK (
  "applies_to" IN ('personal', 'business', 'both')
);--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   2. THE TENANT HOLDS TWO SUBSCRIPTIONS, NOT ONE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `subscription_plan_id` / `subscription_expiry` are UNCHANGED and are now
-- explicitly the PERSONAL axis. Nothing is renamed on purpose: `planStatus()`
-- (src/lib/planGate.ts), `requireActivePlan`, `getUserFromRequest` and roughly
-- 137 routes read those two columns, and a rename would be a flag day for all
-- of them to gain nothing.
--
-- The business axis takes the same two column NAMES with a prefix, so
-- `planStatus()` — which is duck-typed on `subscriptionPlanId` /
-- `subscriptionExpiry` — can be handed either half after a trivial re-shape.
-- One expiry rule, not two implementations that drift.
--
-- NULL `business_plan_id` means "no business subscription", and is NOT the same
-- as a NULL expiry, which means lifetime — the distinction `planStatus()`
-- already draws for the personal side.
--
-- These land NULL and are then backfilled by §6d for the tenants that already
-- run a business account, because those are paying for one today through the
-- single plan in `subscription_plan_id`. Read §6 before assuming a fresh column
-- here means a fresh subscription.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "business_plan_id" uuid REFERENCES "subscription_plans"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "business_plan_expiry" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "extra_members_per_company" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "extra_companies" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   3. A PAYMENT KNOWS WHICH HALF IT BOUGHT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `applies_to` is NULLABLE here, unlike on the plan, and the null is meaningful:
-- it marks a payment taken before this migration, when there was only one
-- account to buy. The billing history reads those into the Personal tab, which
-- is where they belong.
--
-- `plans_purchased` is the line items of a COMBINED checkout — one Razorpay
-- order paying for the personal plan and the business plan together:
--   [{ "planId": "...", "appliesTo": "business", "billingCycle": "YEARLY",
--      "amount": 4999 }]
-- Shaped as jsonb rather than a child table for the same reason
-- `addons_purchased` already is: it is a frozen record of what was bought at a
-- price that no longer exists, not a live relation anything joins to.
--
-- `plan_id` is untouched and still carries the primary line, so the invoice
-- generator, the admin screens and the payment webhook keep working unread.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "applies_to" varchar(16),
  ADD COLUMN IF NOT EXISTS "plans_purchased" jsonb;--> statement-breakpoint

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_applies_to_ck";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_applies_to_ck" CHECK (
  "applies_to" IS NULL OR "applies_to" IN ('personal', 'business', 'both')
);--> statement-breakpoint

-- Serves the per-axis billing history, which is the one new query on this table.
CREATE INDEX IF NOT EXISTS "payments_tenant_applies_to_idx"
  ON "payments" ("tenant_id", "applies_to");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   4. THE CREDIT LEDGER: ATTRIBUTION ONLY, ONE WALLET STILL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ ON DELETE SET NULL, and this is the opposite of what §5 does two blocks
-- down. The reason is `balance_after`.
--
-- There is ONE wallet (`tenants.ai_credits_balance`) and this table is its
-- single running total: every row's `balance_after` is the balance immediately
-- after that movement. Deleting rows out of the middle of it — which is what
-- CASCADE would do when a company is erased — leaves a ledger whose arithmetic
-- no longer reconciles to the column it exists to explain, and no way to tell
-- that from a lost write.
--
-- So an erased company's spending survives as unattributed movement. That is
-- the correct answer for money: the credits were genuinely spent from the shared
-- wallet, and they did not come back when the company went away.
--
-- NULL means "not attributed to any company", which covers both the personal
-- workspace and every GRANT — a plan or add-on grant lands in the shared wallet
-- and belongs to no single workspace, so nothing should try to file it under one.
ALTER TABLE "credit_transactions"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Serves the per-workspace ledger tab: this tenant's rows for one workspace,
-- newest first. Leads with tenant_id like every other index here.
CREATE INDEX IF NOT EXISTS "credit_transactions_tenant_company_created_idx"
  ON "credit_transactions" ("tenant_id", "company_id", "created_at");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   5. THE AUDIT TRAIL: ONE HISTORY PER WORKSPACE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ ON DELETE CASCADE, deliberately unlike §4 above and unlike every record
-- table (which use RESTRICT so a company cannot silently take its paperwork).
--
-- Neither of the other two answers works here:
--   · RESTRICT would make erasing a company impossible until its history were
--     deleted by hand — and a company erasure is now a real, supported action.
--   · SET NULL is worse than either. NULL reads as "the household" in the tab
--     strip, so retiring Acme would silently move every trace of Acme's activity
--     into the PERSONAL audit tab. That is one workspace's history surfacing in
--     another's, inside a feature whose entire purpose is keeping them apart.
--
-- CASCADE is coherent because the trail describes records the erasure destroys.
-- The fact OF the erasure is not lost: `eraseCompanyWorkspace` writes its
-- summary row at tenant level (company_id NULL) BEFORE deleting the company, so
-- that row is not a child of what it describes and survives it.
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE CASCADE;--> statement-breakpoint

-- Serves the per-workspace audit tab (tenant + workspace + newest-first), the
-- same shape as the existing `audit_logs_tenant_created_idx` serves the Summary
-- tab. Both are needed: the summary query has no company predicate at all, so it
-- cannot use this one.
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_company_created_idx"
  ON "audit_logs" ("tenant_id", "company_id", "created_at");--> statement-breakpoint

-- ── Backfill, only where the attribution is not a guess ────────────────────
--
-- A document's audit rows carry `entity_id`, so the workspace can be read
-- straight off the document they describe. This is the only join available:
-- passwords, to-dos and contacts write audit rows too, but their `entity_type`
-- values are not uniform across the trail's history and a wrong guess here is
-- permanent — an audit row must not be made to claim a workspace it cannot
-- prove.
--
-- Everything unmatched stays NULL and reads as Personal, which is what it was
-- when it was written: every one of those rows predates the business account.
UPDATE "audit_logs" AS a
   SET "company_id" = d."company_id"
  FROM "documents" AS d
 WHERE a."entity_type" = 'documents'
   AND a."entity_id" = d."id"
   AND d."company_id" IS NOT NULL;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   6. KEEP EVERY LIVE BUSINESS TENANT WORKING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Everything above defaults the new business columns to 0/NULL, which is right
-- for a schema and wrong for the tenants already running on it. Today ONE plan
-- covers a tenant's whole account, so a tenant with `account_type` in
-- ('business','both') is already paying for its companies and its employees
-- through `subscription_plan_id`.
--
-- Without this block, the moment the new quota checks ship those tenants would
-- be told their plan includes no business account: `POST /api/companies` would
-- refuse (max_companies 0) and so would adding an employee
-- (max_members_per_company 0). Onboarding, which creates the first company, would
-- fail outright.
--
-- So the backfill states what is ALREADY TRUE rather than granting anything new.
--
-- ── 6a. A plan a business tenant holds is a plan that covers business ──────
UPDATE "subscription_plans" p
   SET "applies_to" = 'both'
 WHERE p."applies_to" = 'personal'
   AND EXISTS (
     SELECT 1 FROM "tenants" t
      WHERE t."subscription_plan_id" = p."id"
        AND t."account_type" IN ('business', 'both')
        AND t."deleted_at" IS NULL
   );--> statement-breakpoint

-- ── 6b. Employees keep the seats they already occupy ──────────────────────
-- `max_members` was the WHOLE roster's limit until now, so mirroring it gives
-- each company the ceiling the entire tenant used to share. Deliberately
-- generous rather than exact: it is never LESS than what a tenant holds today,
-- so moving to a per-company grain cannot put an existing member over quota on
-- the day this runs. An operator re-prices it afterwards in Admin → Plans.
UPDATE "subscription_plans"
   SET "max_members_per_company" = "max_members"
 WHERE "applies_to" = 'both'
   AND "max_members_per_company" = 0;--> statement-breakpoint

-- ── 6c. Companies: never fewer than a tenant already has ──────────────────
-- The floor of 3 is a starting allowance for a plan nobody has filled yet; the
-- GREATEST is the part that matters, and it is per-plan over every tenant
-- holding it, so no existing company is retroactively over quota. An operator
-- re-prices these afterwards in Admin → Plans; this only has to avoid breaking
-- the tenants that are live right now.
UPDATE "subscription_plans" p
   SET "max_companies" = GREATEST(
     3,
     COALESCE((
       SELECT MAX(c.n)
         FROM (
           SELECT t."id" AS tenant_id, count(*) AS n
             FROM "companies" c2
             JOIN "tenants" t ON t."id" = c2."tenant_id"
            WHERE t."subscription_plan_id" = p."id"
              AND c2."deleted_at" IS NULL
            GROUP BY t."id"
         ) c
     ), 0)
   )
 WHERE p."applies_to" = 'both'
   AND p."max_companies" = 0;--> statement-breakpoint

-- ── 6d. Record the business subscription these tenants already have ───────
-- Same plan id and same expiry as their personal axis, because it is literally
-- the same subscription — one payment that has always covered both halves. This
-- is what makes `axisStatus(tenant, 'business')` report "active" for a tenant
-- that has been paying all along, rather than "never subscribed".
UPDATE "tenants"
   SET "business_plan_id" = "subscription_plan_id",
       "business_plan_expiry" = "subscription_expiry"
 WHERE "account_type" IN ('business', 'both')
   AND "subscription_plan_id" IS NOT NULL
   AND "business_plan_id" IS NULL;--> statement-breakpoint
