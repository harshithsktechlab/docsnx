const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://sunil:dev_secure_2026@localhost:5432/postgres"
  });
  await client.connect();
  console.log("Connected to PostgreSQL database.");

  try {
    console.log("Recreating public schema if missing...");
    await client.query("CREATE SCHEMA IF NOT EXISTS public;");
    await client.query("GRANT ALL ON SCHEMA public TO public;");
    await client.query("GRANT ALL ON SCHEMA public TO sunil;");
    console.log("Successfully created/granted schema public!");
  } catch (error) {
    console.error("Error during schema recreation:", error);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
