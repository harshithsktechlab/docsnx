import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  await client.query(`
    INSERT INTO subscription_plans (name, price, ai_credits, max_members, storage_limit_gb, is_default, is_active)
    SELECT 'Enterprise', 999, 10000, 10, 100, false, true
    WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name ILIKE 'enterprise')
  `);
  console.log('Enterprise plan ensured');
  await client.end();
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
