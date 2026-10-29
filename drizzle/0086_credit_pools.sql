-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0086 — AI credits split into a PERSONAL pool and a BUSINESS pool        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Until now a tenant held ONE AI wallet and a plan granted one number into it.
-- A "Personal + Business" plan was simply its own figure, so nothing said how
-- much of it was meant for the household and how much for the companies.
--
-- After this migration:
--   · every plan carries TWO figures — what it grants the Personal pool and what
--     it grants the Business pool. A combined plan is the sum of the two plans it
--     combines (Personal 100 + Business 500 = 600).
--   · a tenant holds TWO balances. `ai_credits_balance` KEEPS ITS NAME and is now
--     the PERSONAL pool (about twenty-five readers use it; renaming gains nothing),
--     `ai_credits_balance_business` is the new one.
--   · every ledger row says which pool it moved.
--
-- `subscription_plans.ai_credits` stays, as the TOTAL, so every reader that only
-- wants "how many credits does this plan include" (homepage, /billing, meters,
-- admin tables) is untouched. A CHECK keeps total and parts from ever drifting.
--
-- Additive and idempotent: columns use IF NOT EXISTS, the plan backfill only
-- touches rows still at 0/0, and the balance split is guarded by the ledger row it
-- writes (`pool_split`), so a re-run finds nothing left to do.

-- ═══════════════════════════════════════════════════════════════════════════
--   1. PLANS: TWO FIGURES, ONE TOTAL
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "subscription_plans"
  ADD COLUMN IF NOT EXISTS "ai_credits_personal" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "ai_credits_business" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- A Personal plan grants the Personal pool; a Business plan the Business pool.
UPDATE "subscription_plans"
   SET "ai_credits_personal" = "ai_credits"
 WHERE "applies_to" = 'personal'
   AND "ai_credits_personal" = 0 AND "ai_credits_business" = 0;--> statement-breakpoint

UPDATE "subscription_plans"
   SET "ai_credits_business" = "ai_credits"
 WHERE "applies_to" = 'business'
   AND "ai_credits_personal" = 0 AND "ai_credits_business" = 0;--> statement-breakpoint

-- An ACTIVE combined plan is the sum of the cheapest active Personal plan and the
-- cheapest active Business plan, which is the rule `syncComboCredits` keeps.
-- An INACTIVE combined plan (a trial) keeps the credits it always had and is
-- divided 1 : 5 — those are the proportions of the current price list, and a
-- trial is not derived from anything, so it must not change by being migrated.
UPDATE "subscription_plans" c
   SET "ai_credits_personal" = COALESCE((
         SELECT p."ai_credits_personal" FROM "subscription_plans" p
          WHERE p."applies_to" = 'personal' AND p."is_active" = true
          ORDER BY COALESCE(p."price_yearly", p."price", p."price_one_time") NULLS LAST, p."name"
          LIMIT 1), round(c."ai_credits" / 6.0)::int),
       "ai_credits_business" = COALESCE((
         SELECT b."ai_credits_business" FROM "subscription_plans" b
          WHERE b."applies_to" = 'business' AND b."is_active" = true
          ORDER BY COALESCE(b."price_yearly", b."price", b."price_one_time") NULLS LAST, b."name"
          LIMIT 1), c."ai_credits" - round(c."ai_credits" / 6.0)::int)
 WHERE c."applies_to" = 'both' AND c."is_active" = true
   AND c."ai_credits_personal" = 0 AND c."ai_credits_business" = 0;--> statement-breakpoint

UPDATE "subscription_plans"
   SET "ai_credits_personal" = round("ai_credits" / 6.0)::int,
       "ai_credits_business" = "ai_credits" - round("ai_credits" / 6.0)::int
 WHERE "applies_to" = 'both' AND "is_active" = false
   AND "ai_credits_personal" = 0 AND "ai_credits_business" = 0;--> statement-breakpoint

-- The total follows the parts. For an active combined plan this is what turns
-- today's 600 into 100 + 500 and not the other way round.
UPDATE "subscription_plans"
   SET "ai_credits" = "ai_credits_personal" + "ai_credits_business"
 WHERE "ai_credits" <> "ai_credits_personal" + "ai_credits_business";--> statement-breakpoint

ALTER TABLE "subscription_plans" DROP CONSTRAINT IF EXISTS "subscription_plans_ai_credits_sum_ck";--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_ai_credits_sum_ck" CHECK (
  "ai_credits" = "ai_credits_personal" + "ai_credits_business"
  AND "ai_credits_personal" >= 0 AND "ai_credits_business" >= 0
);--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   2. TENANTS: TWO BALANCES, AND A SHORT-LIVED CONSENT TO BORROW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ai_credits_balance` = the PERSONAL pool. Not renamed on purpose.
--
-- The `ai_borrow_*` trio records that a member agreed to spend the OTHER pool for
-- a few minutes after theirs ran out. It is a consent, not a balance: it is
-- checked on every spend and expires on its own, and it names the member, so one
-- person's "yes" never lets someone else's calls draw on the other pool.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "ai_credits_balance_business" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "ai_borrow_from" varchar(16),
  ADD COLUMN IF NOT EXISTS "ai_borrow_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "ai_borrow_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_ai_borrow_from_ck";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_ai_borrow_from_ck" CHECK (
  "ai_borrow_from" IS NULL OR "ai_borrow_from" IN ('personal', 'business')
);--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   3. THE LEDGER NAMES THE POOL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `balance_after` is now the running total of THAT pool. Every existing row was
-- written when there was one wallet, and that wallet became the Personal pool, so
-- 'personal' is the true value for all of them and not merely a default.
ALTER TABLE "credit_transactions"
  ADD COLUMN IF NOT EXISTS "pool" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

ALTER TABLE "credit_transactions" DROP CONSTRAINT IF EXISTS "credit_transactions_pool_ck";--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_pool_ck" CHECK (
  "pool" IN ('personal', 'business')
);--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
--   4. DIVIDE THE BALANCES THAT ALREADY EXIST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A tenant with a Personal + Business account held one pot; it is divided 1 : 5,
-- the proportions of the plan price list (100 : 500). A business-only tenant has
-- no personal workspace, so all of it goes to Business. A personal tenant is
-- untouched — its wallet simply IS the Personal pool now.
--
-- Credits are moved, never created or lost, and each move is written as a PAIR of
-- ledger rows (− from Personal, + to Business) so the per-tenant sum the admin
-- Tenants card reads ("received − used") is exactly what it was before.
--
-- Guarded by the `pool_split` row itself: a tenant that already has one is never
-- divided twice.
WITH "split" AS (
  SELECT t."id" AS tenant_id,
         CASE t."account_type" WHEN 'both' THEN round(t."ai_credits_balance" / 6.0)::int ELSE 0 END AS personal_after,
         t."ai_credits_balance"
           - CASE t."account_type" WHEN 'both' THEN round(t."ai_credits_balance" / 6.0)::int ELSE 0 END AS moved
    FROM "tenants" t
   WHERE t."account_type" IN ('both', 'business')
     AND t."ai_credits_balance" > 0
     AND t."ai_credits_balance_business" = 0
     AND NOT EXISTS (
       SELECT 1 FROM "credit_transactions" x
        WHERE x."tenant_id" = t."id" AND x."reason" = 'pool_split'
     )
), "ledger" AS (
  INSERT INTO "credit_transactions"
    ("tenant_id", "user_id", "company_id", "amount", "balance_after", "reason", "description", "pool")
  SELECT s.tenant_id, NULL::uuid, NULL::uuid, -s.moved, s.personal_after, 'pool_split',
         'Credits divided between the Personal and Business pools — ' || s.moved || ' moved to Business.', 'personal'
    FROM "split" s WHERE s.moved > 0
  UNION ALL
  SELECT s.tenant_id, NULL::uuid, NULL::uuid, s.moved, s.moved, 'pool_split',
         'Credits divided between the Personal and Business pools — ' || s.moved || ' received from Personal.', 'business'
    FROM "split" s WHERE s.moved > 0
  RETURNING 1
)
UPDATE "tenants" t
   SET "ai_credits_balance" = s.personal_after,
       "ai_credits_balance_business" = s.moved,
       "updated_at" = now()
  FROM "split" s
 WHERE t."id" = s.tenant_id AND s.moved > 0;
