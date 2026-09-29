import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5432/docsnx_db?schema=public',
});

async function main() {
  try {
    await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS amc_last_paid_at timestamp;');
    await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS amc_next_due_date timestamp;');
    await pool.query("ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_lifetime boolean NOT NULL DEFAULT false;");
    await pool.query("ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS amc_amount numeric(12,2) NOT NULL DEFAULT '0';");
    await pool.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type varchar(50) NOT NULL DEFAULT 'standard';");
    console.log('AMC columns added successfully.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    pool.end();
  }
}

main();
