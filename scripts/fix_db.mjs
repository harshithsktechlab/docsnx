import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://admin:dev_secure_2026@80.225.252.161:5432/docsnx_db?schema=public'
});

async function run() {
  try {
    await client.connect();
    
    // Create ai_analysis_cache
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_analysis_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        analysis_data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    
    console.log('ai_analysis_cache table created.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

run();
