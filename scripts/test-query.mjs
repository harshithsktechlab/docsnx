import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  try {
    const res = await client.query(`select "id", "name", "price", "price_yearly", "price_one_time", "price_usd", "price_yearly_usd", "price_one_time_usd", "amc_amount", "amc_amount_usd", "ai_credits", "max_members", "storage_limit_gb", "is_default", "badge_color", "duration_days", "is_lifetime", "is_active", "created_at", "updated_at" from "subscription_plans" "subscriptionPlans" where "subscriptionPlans"."name" ilike $1 limit $2`, ['enterprise', 1]);
    console.log('Query succeeded! Rows:', res.rows.length);
  } catch (e) {
    console.error('Query failed:', e.message);
  }
  await client.end();
}

run();
