import { Pool } from 'pg';
import { config } from 'dotenv';
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL || 'postgresql://admin:dev_secure_2026@127.0.0.1:5433/docsnx_db?schema=public';

const pool = new Pool({
  connectionString,
});

async function main() {
  console.log('Connecting to database to update Free Plan to Trial Plan...');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Update the default plan
    const res = await client.query(`
      UPDATE subscription_plans
      SET 
        name = 'Trial Plan',
        max_members = 5,
        storage_limit_gb = 5,
        ai_credits = 100
      WHERE is_default = true OR name ILIKE '%free%'
      RETURNING *;
    `);
    
    console.log('Updated plan:', res.rows[0]);
    
    await client.query('COMMIT');
    console.log('Database update completed successfully!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update failed. Rolled back.', error);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
