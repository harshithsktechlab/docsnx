-- ============================================================
-- BACKFILL SCRIPT: Migrate tenants.subscription_plan (code string)
--                  to tenants.subscription_plan_id (UUID FK)
-- Run this BEFORE running `npx drizzle-kit push` or migrate.
-- ============================================================

-- Step 1: Add the new UUID column (nullable for now)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan_id UUID REFERENCES subscription_plans(id) ON DELETE SET NULL;

-- Step 2: Backfill: match the old string code to the plan's UUID
UPDATE tenants t
SET subscription_plan_id = sp.id
FROM subscription_plans sp
WHERE LOWER(sp.code) = LOWER(t.subscription_plan)
  AND t.subscription_plan_id IS NULL;

-- Step 3: Also handle cases where subscription_plan already stores a UUID
UPDATE tenants t
SET subscription_plan_id = t.subscription_plan::uuid
WHERE t.subscription_plan_id IS NULL
  AND t.subscription_plan ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Step 4: For any tenant that still has no match, assign the default plan
UPDATE tenants t
SET subscription_plan_id = (SELECT id FROM subscription_plans WHERE is_default = true LIMIT 1)
WHERE t.subscription_plan_id IS NULL;

-- Step 5: (Optional verification) Show any tenants that still have no plan assigned
-- SELECT id, name, subscription_plan FROM tenants WHERE subscription_plan_id IS NULL;

-- Step 6: Drop the old string column
-- (Only run AFTER verifying data integrity above and deploying the new code)
-- ALTER TABLE tenants DROP COLUMN IF EXISTS subscription_plan;

-- Step 7: Remove code column from subscription_plans
-- ALTER TABLE subscription_plans DROP COLUMN IF EXISTS code;

-- Step 8: Remove code column from addons
-- ALTER TABLE addons DROP COLUMN IF EXISTS code;
