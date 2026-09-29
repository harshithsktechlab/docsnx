import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  console.log("Dropping local public schema...");
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  console.log("Local public schema recreated.");
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
