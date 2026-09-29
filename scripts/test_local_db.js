const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://sunil:dev_secure_2026@localhost:5434/postgres"
  });
  try {
    await client.connect();
    console.log("Connected to local database!");
    await client.query("CREATE SCHEMA IF NOT EXISTS public;");
    console.log("Created public schema on local database!");
  } catch (err) {
    console.error("Local database error:", err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(console.error);
