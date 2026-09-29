const { Client } = require('pg');
require('dotenv').config();
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://admin:dev_secure_2026@127.0.0.1:5433/docsnx_db?schema=public' });

async function run() {
  await client.connect();
  try {
    console.log("Adding columns to system_configs...");
    await client.query(`ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS platform_name VARCHAR(255);`);
    await client.query(`ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS platform_gstin VARCHAR(50);`);
    await client.query(`ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS platform_address TEXT;`);

    console.log("Adding columns to tenants...");
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_name VARCHAR(255);`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_gst VARCHAR(50);`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_address TEXT;`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_family_members INTEGER DEFAULT 1;`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS extra_family_members INTEGER DEFAULT 0;`);

    console.log("Adding columns to audit_logs...");
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource VARCHAR(255);`);

    console.log("Adding columns to subscription_plans...");
    await client.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS duration_days INTEGER;`);
    await client.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_lifetime BOOLEAN DEFAULT false;`);

    console.log("Adding columns to payments...");
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS addon_id UUID REFERENCES addons(id) ON DELETE SET NULL;`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_url TEXT;`);

    console.log("Done.");
  } catch (e) {
    console.error(e);
  } finally {
    client.end();
  }
}

run();
