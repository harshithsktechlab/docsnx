import { Pool } from 'pg';

export default async function globalTeardown() {
  console.log('Global Teardown: Deleting E2E Test Tenant...');
  
  if (!process.env.DATABASE_URL) {
    console.warn('No DATABASE_URL found in environment. Skipping teardown.');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Typically local dev doesn't need ssl, adjust if testing against prod DB
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    const res = await pool.query("DELETE FROM tenants WHERE name = 'E2E Test Tenant'");
    console.log(`Global Teardown: E2E Test Tenant deleted (${res.rowCount} rows affected).`);
  } catch (error) {
    console.error('Error during global teardown:', error);
  } finally {
    await pool.end();
  }
}
