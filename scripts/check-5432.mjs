import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5432/docsnx_db?schema=public' });

async function run() {
  await client.connect();
  const res = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'subscription_plans';
  `);
  console.log('Columns in subscription_plans on port 5432:', res.rows.map(r => r.column_name));
  await client.end();
}

run().catch(console.error);
