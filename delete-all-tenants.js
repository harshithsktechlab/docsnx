const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function deleteAllTenants() {
  try {
    console.log('Connecting to database:', process.env.DATABASE_URL.split('@')[1]); // Log safe part of connection string
    const res = await pool.query('DELETE FROM tenants');
    console.log(`Successfully deleted ${res.rowCount} tenants.`);
  } catch (err) {
    console.error('Error deleting tenants:', err);
  } finally {
    await pool.end();
  }
}

deleteAllTenants();
