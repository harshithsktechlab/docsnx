import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  const sql = fs.readFileSync(path.join(process.cwd(), 'scripts', 'insert_superadmin.sql'), 'utf8');
  await client.query(sql);
  console.log("Local superadmin inserted.");
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
