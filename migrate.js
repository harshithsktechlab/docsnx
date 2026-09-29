const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    await pool.query('ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "plan_billing_cycle" varchar(50);');
    console.log('Column plan_billing_cycle added successfully.');
  } catch (err) {
    console.error('Error adding column:', err);
  } finally {
    await pool.end();
  }
}

run();
