import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5433/docsnx_db?schema=public'
});

async function run() {
  await client.connect();
  await client.query("INSERT INTO subscription_plans (name, code, price, duration_days, is_default, is_active) VALUES ('Free Plan', 'FREE', 0, 14, true, true), ('Enterprise Plan', 'ENTERPRISE', 999, 365, false, true) ON CONFLICT (code) DO NOTHING;");
  console.log('Plans inserted');
  process.exit(0);
}
run().catch(console.error);
