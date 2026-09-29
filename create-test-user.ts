import { db } from './src/lib/db.js';
import { tenants, users } from './src/db/schema.js';
import bcrypt from 'bcrypt';

async function seed() {
  try {
    const hash = await bcrypt.hash('123456', 10);
    
    // Check if tenant exists
    let tenantId;
    const existingTenants = await db.select().from(tenants).limit(1);
    if (existingTenants.length === 0) {
      const inserted = await db.insert(tenants).values({ name: 'System' }).returning({ id: tenants.id });
      tenantId = inserted[0].id;
    } else {
      tenantId = existingTenants[0].id;
    }

    // Insert user
    await db.insert(users).values({
      tenantId,
      email: 'tenant@hsk.com',
      passwordHash: hash,
      name: 'Tenant Admin',
      role: 'TENANT_ADMIN'
    }).onConflictDoNothing({ target: users.email });

    console.log('Seed successful');
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seed();
