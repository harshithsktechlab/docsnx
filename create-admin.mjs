import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5433/docsnx_db?schema=public'
});

async function run() {
  await client.connect();
  const hash = '$2a$10$n.60JvPJG9S7TWAhiFRJJ.2eiGo2KWxLLd6cFATcx8SNfzoFoYhom';
  
  // Check user
  const userRes = await client.query("SELECT id, role FROM users WHERE email = $1", ['sunil@hsk.com']);
  if (userRes.rows.length > 0) {
    console.log("User sunil@hsk.com already exists. Updating role and password...");
    await client.query("UPDATE users SET role = 'SUPER_ADMIN', password_hash = $1 WHERE email = $2", [hash, 'sunil@hsk.com']);
    console.log("Updated to SUPER_ADMIN with password 123456.");
    process.exit(0);
  }

  console.log("Creating SUPER_ADMIN user...");
  
  let tenantRes = await client.query("SELECT id FROM tenants WHERE name = 'System' LIMIT 1");
  let tenantId;
  if (tenantRes.rows.length > 0) {
    tenantId = tenantRes.rows[0].id;
  } else {
    tenantRes = await client.query("SELECT id FROM tenants LIMIT 1");
    if (tenantRes.rows.length > 0) {
      tenantId = tenantRes.rows[0].id;
    } else {
       console.log("No tenants exist. Creating one...");
       const insertTenant = await client.query("INSERT INTO tenants (name, subscription_plan) VALUES ('System', 'ENTERPRISE') RETURNING id");
       tenantId = insertTenant.rows[0].id;
    }
  }

  await client.query(
    "INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)",
    [tenantId, 'sunil@hsk.com', hash, 'Sunil Admin', 'SUPER_ADMIN']
  );
  
  console.log("Superadmin created successfully with password 123456.");
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
