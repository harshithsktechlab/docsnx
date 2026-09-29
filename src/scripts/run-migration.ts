import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://admin:dev_secure_2026@127.0.0.1:5433/docsnx_db?schema=public';

const pool = new Pool({
  connectionString,
});

async function main() {
  console.log('Connecting to database to apply migrations...');
  const client = await pool.connect();
  
  try {
    // Start transaction
    await client.query('BEGIN');
    
    // Check if column exists to avoid errors if already migrated
    const colCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='tenants' AND column_name='subscription_plan'
    `);
    
    if (colCheck.rowCount > 0) {
      // Step 1: Add the new UUID column if it doesn't exist
      console.log('Step 1: Adding subscription_plan_id column to tenants table');
      await client.query(`
        ALTER TABLE tenants 
        ADD COLUMN IF NOT EXISTS subscription_plan_id UUID REFERENCES subscription_plans(id) ON DELETE SET NULL;
      `);

      // Step 2: Backfill: match old string code to the plan's UUID
      console.log('Step 2: Backfilling subscription_plan_id matching old codes...');
      await client.query(`
        UPDATE tenants t
        SET subscription_plan_id = sp.id
        FROM subscription_plans sp
        WHERE LOWER(sp.code) = LOWER(t.subscription_plan)
          AND t.subscription_plan_id IS NULL;
      `);
      
      // Step 3: Handle cases where subscriptionPlan already stores a UUID
      console.log('Step 3: Backfilling subscription_plan_id where already a UUID...');
      await client.query(`
        UPDATE tenants t
        SET subscription_plan_id = t.subscription_plan::uuid
        WHERE t.subscription_plan_id IS NULL
          AND t.subscription_plan ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      `);

      // Step 4: Fallback to default plan
      console.log('Step 4: Assigning default plan ID to any remaining null records...');
      await client.query(`
        UPDATE tenants t
        SET subscription_plan_id = (SELECT id FROM subscription_plans WHERE is_default = true LIMIT 1)
        WHERE t.subscription_plan_id IS NULL;
      `);

      // Step 5: Verify no nulls exist
      const nullCheck = await client.query('SELECT COUNT(*) FROM tenants WHERE subscription_plan_id IS NULL');
      console.log(`Tenants with null subscription_plan_id: ${nullCheck.rows[0].count}`);

      // Step 6: Drop the old columns
      console.log('Step 6: Dropping old code columns and subscription_plan from tenants...');
      await client.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS subscription_plan CASCADE;`);
      await client.query(`ALTER TABLE subscription_plans DROP COLUMN IF EXISTS code CASCADE;`);
      await client.query(`ALTER TABLE addons DROP COLUMN IF EXISTS code CASCADE;`);
    } else {
      console.log('Migration already appears to be completed (subscription_plan column not found in tenants table).');
    }
    
    // Commit transaction
    await client.query('COMMIT');
    console.log('Migration completed successfully!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed. Rolled back.', error);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
