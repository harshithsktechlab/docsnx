import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  const res = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'subscription_plans';
  `);
  console.log('Columns in subscription_plans:', res.rows.map(r => r.column_name));
  await client.end();
}

run().catch(console.error);
