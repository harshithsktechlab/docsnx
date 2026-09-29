-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0058 — the price list, and the end of the never-expiring free account   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0057 gave the account two axes and taught every quota to read them. There was
-- still nothing to sell: the three plans in this table are leftovers, two of
-- them carry `duration_days IS NULL` — which `planExpiry()` returns as null and
-- `planStatus()` reads as LIFETIME — and there are no `addons` rows at all, so
-- "additional user" could not be bought under any circumstances.
--
-- This migration writes the real list:
--
--   Personal              ₹999/yr    4 members incl. admin          1000 credits
--   Business              ₹2999/yr   1 company, 5 members in each   1000 credits
--   Personal + Business   ₹3499/yr   both of the above              2000 credits
--
--   Additional user (personal)   ₹499/yr
--   Additional user (business)   ₹699/yr   ← per company
--   Additional company           ₹1999/yr
--
-- plus one 30-day trial PER ACCOUNT TYPE, because signup asks which account the
-- customer wants and can then hand them the matching one.
--
-- ⚠ It also MOVES ALL 13 LIVE TENANTS onto those trials, which takes real term
-- away from two of them. See §4. That was decided deliberately and with both
-- named; it is not a side effect.

-- ═══════════════════════════════════════════════════════════════════════════
--   1. A PLAN CAN BE SOLD ANNUALLY AND NOT MONTHLY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every price in this list is per year, and until now that was unrepresentable.
-- `price` is the MONTHLY price and was NOT NULL, so an annual-only plan had two
-- possible spellings and both are wrong:
--
--   price = 0    the card renders "Free" and a customer can check out a year's
--                product for nothing;
--   price = 999  `expiryForCycle('MONTHLY')` grants ONE MONTH for the annual
--                fee (src/app/api/payments/verify/route.ts).
--
-- NULL is the third answer and the correct one: "not sold on this cycle". The
-- checkout already understands it — `defaultDuration()` and the cycle <option>
-- guards in UnifiedCheckoutModal.jsx both test `price !== null`, so a plan with
-- no monthly price opens on YEARLY by itself and never offers MONTHLY.
ALTER TABLE "subscription_plans" ALTER COLUMN "price" DROP NOT NULL;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   2. AN ADD-ON CAN SELL A COMPANY, OR A SEAT INSIDE ONE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `addons` carried `extra_members` alone, which is the PERSONAL roster. Two of
-- the three add-ons above had nowhere to live: there was no way to express
-- "one more company" or "one more employee on a company".
--
-- Same grain as the plan columns 0057 added, and read the same way — summed
-- from LIVE `tenant_addons` at the point of the check rather than written onto
-- `tenants`, which is how `extra_members` has always worked and what makes an
-- add-on's own expiry apply for free.
ALTER TABLE "addons"
  ADD COLUMN IF NOT EXISTS "extra_companies" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "extra_members_per_company" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   3. THE ROWS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every insert is guarded on the name so a from-scratch migration replay — which
-- this repo does perform, see the rebuild notes — cannot double-insert.
--
-- ── Why the seat numbers are what they are ────────────────────────────────
-- `max_members` INCLUDES the tenant admin: `seatPredicate` counts them on the
-- personal axis by ROLE (src/lib/account/seatCounts.ts), so 4 means the admin
-- plus three. `max_members_per_company` does NOT include them — an admin
-- occupies no company seat — so 5 means five employees on each company.
--
-- Storage is 5 GB everywhere and is deliberately not a pricing dimension:
-- Google Drive is mandatory and `checkStorageLimit` measures a Drive tenant
-- against their OWN Drive quota, ignoring the plan. `storage_limit_gb` binds
-- only a tenant with no live grant, who cannot upload at all.

-- ── 3a. The three paid plans ──────────────────────────────────────────────
INSERT INTO "subscription_plans"
  ("name", "applies_to", "price", "price_yearly", "duration_days",
   "max_members", "max_companies", "max_members_per_company",
   "ai_credits", "storage_limit_gb", "is_active", "is_default", "badge_color")
SELECT v.name, v.applies_to, NULL, v.price_yearly, 365,
       v.max_members, v.max_companies, v.max_members_per_company,
       v.ai_credits, 5, true, false, v.badge
  FROM (VALUES
    ('Personal',            'personal', 999.00,  4, 0, 0, 1000, 'secondary'),
    ('Business',            'business', 2999.00, 0, 1, 5, 1000, 'primary'),
    ('Personal + Business', 'both',     3499.00, 4, 1, 5, 2000, 'success')
  ) AS v(name, applies_to, price_yearly, max_members, max_companies,
         max_members_per_company, ai_credits, badge)
 WHERE NOT EXISTS (
   SELECT 1 FROM "subscription_plans" p WHERE p."name" = v.name
 );--> statement-breakpoint

-- ── 3b. One trial per account type ────────────────────────────────────────
--
-- `is_active = false` keeps them out of the buy grid (/billing filters on it)
-- while `getDefaultPlan` still finds them — that lookup asks only `is_default`.
-- A trial is assigned, never purchased, so it needs no price at all.
--
-- `is_default = true` on ALL THREE. Nothing has ever enforced uniqueness on
-- that column, and it now means "the plan a new tenant of THIS SHAPE lands on":
-- signup knows the account type the customer chose and asks for the matching
-- row. See getDefaultPlan(accountType) in src/lib/planProvisioning.ts.
INSERT INTO "subscription_plans"
  ("name", "applies_to", "price", "price_yearly", "duration_days",
   "max_members", "max_companies", "max_members_per_company",
   "ai_credits", "storage_limit_gb", "is_active", "is_default", "badge_color")
SELECT v.name, v.applies_to, NULL, NULL, 30,
       v.max_members, v.max_companies, v.max_members_per_company,
       2000, 5, false, true, 'muted'
  FROM (VALUES
    ('Personal Trial', 'personal', 4, 0, 0),
    ('Business Trial', 'business', 0, 1, 5),
    ('Combo Trial',    'both',     4, 1, 5)
  ) AS v(name, applies_to, max_members, max_companies, max_members_per_company)
 WHERE NOT EXISTS (
   SELECT 1 FROM "subscription_plans" p WHERE p."name" = v.name
 );--> statement-breakpoint

-- ── 3c. The three add-ons ─────────────────────────────────────────────────
-- Annual, matching the plans. `price` (monthly) stays NULL for the same reason
-- it does above; `addons.price` was already nullable.
INSERT INTO "addons"
  ("name", "description", "price", "price_yearly", "billing_cycle",
   "ai_credits", "extra_members", "extra_members_per_company",
   "extra_companies", "storage_limit_gb", "is_active")
SELECT v.name, v.description, NULL, v.price_yearly, 'YEARLY',
       0, v.extra_members, v.extra_members_per_company,
       v.extra_companies, 0, true
  FROM (VALUES
    ('Additional user (personal)', 'One more member on the personal account.',
     499.00,  1, 0, 0),
    ('Additional user (business)', 'One more member on EACH company, on top of the plan''s allowance.',
     699.00,  0, 1, 0),
    ('Additional company',         'One more company on the business account.',
     1999.00, 0, 0, 1)
  ) AS v(name, description, price_yearly, extra_members,
         extra_members_per_company, extra_companies)
 WHERE NOT EXISTS (
   SELECT 1 FROM "addons" a WHERE a."name" = v.name
 );--> statement-breakpoint

-- ── 3d. Retire the leftovers ──────────────────────────────────────────────
--
-- Deactivated, NOT deleted: `payments.plan_id` and `tenants.subscription_plan_id`
-- both reference these rows, and a tenant's CURRENT plan name is resolved by id
-- through /api/auth/me rather than from the active list — so retiring one is
-- invisible to anybody already holding it, while removing it would break the
-- payment history that names it.
UPDATE "subscription_plans"
   SET "is_active" = false, "is_default" = false, "updated_at" = now()
 WHERE "name" IN ('Trial Plan', 'trial plan with extra credits', 'pro plan');--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   4. MOVE EVERY LIVE TENANT ONTO THE TRIAL FOR ITS OWN ACCOUNT TYPE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 11 of the 13 live tenants carry `subscription_expiry IS NULL` on a free plan,
-- which reads as a subscription that never ends. This is what closes that.
--
-- ⚠ TWO TENANTS LOSE REMAINING TERM, deliberately and irreversibly:
--     · the tenant on 'pro plan' paid to 2027-09-03 — roughly a year;
--     · one 'both' tenant dated 2026-10-07.
--   Both were named before this was written and the decision was to move
--   everyone with no exceptions. There is no undo short of the nightly dump.
--
-- Nobody changes SHAPE: each tenant lands on the trial matching the
-- `account_type` it already has.

-- ── 4a. The ledger row FIRST, while the old balance is still readable ─────
--
-- `credit_transactions` is the running total behind `tenants.ai_credits_balance`
-- and every row's `balance_after` is the balance immediately after that
-- movement. Setting the column with no matching row would leave arithmetic that
-- cannot reconcile — and nothing could tell that from a lost write.
--
-- `amount` is the DELTA, so it is negative for the two tenants sitting above
-- 2000 today. Rows whose balance is already 2000 are skipped, matching
-- `recordCreditMovement`, which drops a zero-amount movement rather than
-- recording "granted 0 credits".
INSERT INTO "credit_transactions"
  ("tenant_id", "user_id", "company_id", "amount", "balance_after",
   "reason", "description")
SELECT t."id", NULL, NULL, 2000 - t."ai_credits_balance", 2000,
       'trial_grant',
       'Moved to the 30-day trial — balance set to 2,000 AI credits.'
  FROM "tenants" t
 WHERE t."deleted_at" IS NULL
   AND t."ai_credits_balance" <> 2000;--> statement-breakpoint

-- ── 4b. The move ──────────────────────────────────────────────────────────
--
-- The business axis is written for `business` and `both` tenants. 0057 §6d set
-- `business_plan_id` from their OLD plan; leaving it there would strand five
-- tenants pointing at a subscription they no longer hold, and `workspaceExpired`
-- would answer from a retired row.
--
-- `plan_notice_stage`/`plan_notice_sent_at` are cleared so the T-7/T-3/T-1
-- expiry reminders re-arm for the new term — left set, the daily job would
-- treat this term as already announced and the tenant's next word from us would
-- be on the day it lapsed.
UPDATE "tenants" t
   SET "subscription_plan_id"  = p."id",
       "subscription_expiry"   = now() + interval '30 days',
       "business_plan_id"      = CASE WHEN t."account_type" IN ('business', 'both')
                                      THEN p."id" ELSE NULL END,
       "business_plan_expiry"  = CASE WHEN t."account_type" IN ('business', 'both')
                                      THEN now() + interval '30 days' ELSE NULL END,
       "ai_credits_balance"    = 2000,
       "plan_notice_stage"     = NULL,
       "plan_notice_sent_at"   = NULL,
       "updated_at"            = now()
  FROM "subscription_plans" p
 WHERE p."name" = CASE t."account_type"
                    WHEN 'business' THEN 'Business Trial'
                    WHEN 'both'     THEN 'Combo Trial'
                    ELSE 'Personal Trial'
                  END
   AND t."deleted_at" IS NULL;--> statement-breakpoint
