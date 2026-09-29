const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://sunil:dev_secure_2026@localhost:5434/postgres"
  });
  await client.connect();
  console.log("Connected to local database postgres.");

  try {
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    console.log("Tables in public schema:");
    console.table(tables.rows);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
