import pg from 'pg';
const { Client } = pg;

const client5433 = new Client({ connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5433/docsnx_db?schema=public' });
const client5432 = new Client({ connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5432/docsnx_db?schema=public' });

async function sync() {
  await client5433.connect();
  await client5432.connect();

  console.log('Fetching schema from port 5433...');
  const tablesRes = await client5433.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  `);

  for (const row of tablesRes.rows) {
    const tableName = row.table_name;

    // Check if table exists in 5432
    const existsRes = await client5432.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1;
    `, [tableName]);

    if (existsRes.rows.length === 0) {
      console.log(`Table ${tableName} missing on 5432. Creating simple dummy or cloning structure...`);
      // Get CREATE TABLE DDL or let's create table
      // Actually let's just create table with id uuid primary key default gen_random_uuid()
      await client5432.query(`CREATE TABLE IF NOT EXISTS "${tableName}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`);
    }

    // Now get all columns from 5433
    const colsRes = await client5433.query(`
      SELECT column_name, data_type, character_maximum_length, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1;
    `, [tableName]);

    for (const col of colsRes.rows) {
      const colName = col.column_name;
      const colExistsRes = await client5432.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2;
      `, [tableName, colName]);

      if (colExistsRes.rows.length === 0) {
        let pgType = col.data_type;
        if (pgType === 'USER-DEFINED') {
          pgType = 'VARCHAR(100)';
        } else if (pgType === 'character varying') {
          pgType = col.character_maximum_length ? `VARCHAR(${col.character_maximum_length})` : 'TEXT';
        } else if (pgType === 'timestamp without time zone') {
          pgType = 'TIMESTAMP';
        } else if (pgType === 'timestamp with time zone') {
          pgType = 'TIMESTAMPTZ';
        } else if (pgType === 'ARRAY') {
          pgType = 'TEXT[]';
        }
        console.log(`Adding column ${tableName}.${colName} (${pgType}) to port 5432...`);
        try {
          await client5432.query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${colName}" ${pgType}`);
        } catch (err) {
          console.warn(`Failed adding ${tableName}.${colName}: ${err.message}`);
        }
      }
    }
  }

  console.log('Sync complete!');
  await client5433.end();
  await client5432.end();
}

sync().catch(console.error);
