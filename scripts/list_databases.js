const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://sunil:dev_secure_2026@localhost:5432/postgres"
  });
  await client.connect();
  console.log("Connected to PostgreSQL database.");

  try {
    const dbs = await client.query(`SELECT datname FROM pg_database;`);
    console.log("Databases:");
    console.table(dbs.rows);
  } catch (error) {
    console.error("Error listing databases:", error);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
