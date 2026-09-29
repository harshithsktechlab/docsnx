import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5432/docsnx_db?schema=public',
});

async function main() {
  try {
    // Add the has_completed_onboarding column
    await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS has_completed_onboarding boolean NOT NULL DEFAULT false;');
    console.log('has_completed_onboarding added successfully.');
    
    // While we are at it, add the consent columns to users table just in case they were also missed
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_data_processing boolean NOT NULL DEFAULT false;');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_timestamp timestamp;');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_ip_address varchar(45);');
    console.log('Consent columns added successfully.');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    pool.end();
  }
}

main();
