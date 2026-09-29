import pg from 'pg';
const { Client } = pg;
const client = new Client({
  connectionString: 'postgresql://admin:dev_secure_2026@localhost:5433/docsnx_db?schema=public'
});
async function run() {
  await client.connect();
  const hash = '$2a$10$n.60JvPJG9S7TWAhiFRJJ.2eiGo2KWxLLd6cFATcx8SNfzoFoYhom'; 
  
  let tenantRes = await client.query("SELECT id FROM tenants LIMIT 1");
  if (tenantRes.rows.length === 0) { console.error("No tenants"); process.exit(1); }
  const tenantId = tenantRes.rows[0].id;
  
  await client.query(
    "INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING",
    [tenantId, 'tenant@hsk.com', hash, 'Tenant Admin', 'TENANT_ADMIN']
  );
  console.log("Tenant admin created.");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
