const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    console.log('Running manual migrations...');
    await pool.query('ALTER TABLE tenants ALTER COLUMN subscription_plan DROP DEFAULT;');
    await pool.query('CREATE TABLE IF NOT EXISTS trial_used_emails (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(255) UNIQUE NOT NULL, created_at timestamp DEFAULT now() NOT NULL);');
    await pool.query('ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false NOT NULL;');
    await pool.query('ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS badge_color varchar(50) DEFAULT \'secondary\' NOT NULL;');
    await pool.query('ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits integer DEFAULT 0 NOT NULL;');
    await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_name varchar(255);');
    await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_gst varchar(50);');
    await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_address text;');
    await pool.query('ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS platform_name varchar(255);');
    await pool.query('ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS platform_gstin varchar(50);');
    await pool.query('ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS platform_address text;');
    await pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS addon_id uuid REFERENCES addons(id) ON DELETE SET NULL;');
    await pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_url text;');
    console.log('Manual migrations successful.');
  } catch(e){
    console.error('Manual migration error:', e);
  } finally {
    process.exit();
  }
}

run();
