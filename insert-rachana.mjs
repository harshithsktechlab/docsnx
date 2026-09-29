import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Client } = pg;

async function run() {
  try {
    console.log("Connecting to DB...");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    
    console.log("Generating hash...");
    const hash = await bcrypt.hash('123456', 10);
    
    console.log("Inserting user...");
    const sql = `
      DO $$
      DECLARE
          t_id UUID := gen_random_uuid();
          u_id UUID := gen_random_uuid();
          p_id UUID := gen_random_uuid();
      BEGIN
          INSERT INTO tenants (id, name, subscription_plan, slug) VALUES (t_id, 'HSK Organization', 'PRO', 'hsk')
          ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id INTO t_id;
          
          INSERT INTO users (id, tenant_id, email, password_hash, name, role) 
          VALUES (u_id, t_id, 'rachana@hsk.com', '${hash}', 'Rachana', 'SUPER_ADMIN')
          ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id INTO u_id;
          
          INSERT INTO profiles (id, user_id) VALUES (p_id, u_id)
          ON CONFLICT (user_id) DO NOTHING;
      END $$;
    `;
    
    await client.query(sql);
    console.log("Successfully created rachana@hsk.com");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
