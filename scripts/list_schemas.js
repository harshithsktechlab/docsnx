const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://sunil:dev_secure_2026@localhost:5432/postgres"
  });
  await client.connect();
  console.log("Connected to PostgreSQL database.");

  try {
    const schemas = await client.query(`
      SELECT schema_name, schema_owner 
      FROM information_schema.schemata;
    `);
    console.log("Schemas:");
    console.table(schemas.rows);

    const tables = await client.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
    `);
    console.log("Tables:");
    console.table(tables.rows);
  } catch (error) {
    console.error("Error during listing:", error);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
