import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5432/docsnx_db?schema=public' });

async function run() {
  await client.connect();
  console.log('Migrating tables on port 5432...');

  // tenants table adjustments
  await client.query(`
    ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS subscription_plan_id UUID,
    ADD COLUMN IF NOT EXISTS max_members INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS extra_members INTEGER DEFAULT 0;
  `);

  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'subscription_plan') THEN
        ALTER TABLE tenants ALTER COLUMN subscription_plan DROP NOT NULL;
      END IF;
    END $$;
  `);

  // subscription_plans adjustments
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'subscription_plans' AND column_name = 'code') THEN
        ALTER TABLE subscription_plans ALTER COLUMN code DROP NOT NULL;
      END IF;
    END $$;
  `);

  await client.query(`
    ALTER TABLE subscription_plans
    ADD COLUMN IF NOT EXISTS price_yearly DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS price_one_time DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS price_usd DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS price_yearly_usd DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS price_one_time_usd DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS amc_amount_usd DECIMAL(12, 2);
  `);

  await client.query(`
    INSERT INTO subscription_plans (name, price, ai_credits, max_members, storage_limit_gb, is_default, is_active)
    SELECT 'Enterprise', 999, 10000, 10, 100, false, true
    WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name ILIKE 'enterprise');
  `);

  await client.query(`
    INSERT INTO subscription_plans (name, price, ai_credits, max_members, storage_limit_gb, is_default, is_active, duration_days)
    SELECT 'Trial Plan', 0, 100, 2, 5, true, true, 14
    WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE is_default = true);
  `);

  console.log('Migration on port 5432 successful!');
  await client.end();
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
