const { Client } = require('pg');

async function testDb(dbName) {
  const connStr = `postgresql://sunil:dev_secure_2026@localhost:5432/${dbName}`;
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    await client.query("CREATE SCHEMA IF NOT EXISTS public;");
    console.log(`SUCCESS: Created/verified schema public in ${dbName}`);
    return true;
  } catch (err) {
    console.log(`FAILED in ${dbName}:`, err.message);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const dbs = [
    'postgres',
    'tradebull_test',
    'postgres_prod',
    'vastipatrak',
    'VBN1',
    'udyamnx_modular',
    'Padhbee',
  ];
  for (const dbName of dbs) {
    await testDb(dbName);
  }
}

main().catch(console.error);
