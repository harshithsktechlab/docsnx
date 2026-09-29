const { Client } = require('pg');

async function test(connStr) {
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    console.log("Success with connection string:", connStr);
    return true;
  } catch (err) {
    console.error("Failed connection string:", connStr, err.message);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const attempts = [
    "postgresql://postgres:dev_secure_2026@localhost:5432/postgres",
    "postgresql://postgres:postgres@localhost:5432/postgres",
    "postgresql://postgres:admin@localhost:5432/postgres",
    "postgresql://postgres:root@localhost:5432/postgres",
    "postgresql://postgres@localhost:5432/postgres",
  ];
  for (const url of attempts) {
    const ok = await test(url);
    if (ok) {
      console.log("FOUND WORKING USER:", url);
      break;
    }
  }
}

main().catch(console.error);
