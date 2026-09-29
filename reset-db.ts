import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
import * as schema from './src/db/schema';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool, { schema });

async function resetAndSeed() {
  try {
    console.log("Dropping public schema...");
    await db.execute(sql`DROP SCHEMA public CASCADE;`);
    console.log("Creating public schema...");
    await db.execute(sql`CREATE SCHEMA public;`);

    console.log("Running Drizzle Kit push to create tables...");
    execSync('npx drizzle-kit push', { stdio: 'inherit' });

    console.log("Seeding super admin...");
    const [tenant] = await db.insert(schema.tenants).values({
      name: "HSK Tech Lab",
      billingName: "HSK Tech Lab",
      isActive: true,
      hasCompletedOnboarding: true,
    }).returning();

    const hashedPassword = await bcrypt.hash('123456', 10);

    await db.insert(schema.users).values({
      tenantId: tenant.id,
      email: "rachana@hsk.com",
      passwordHash: hashedPassword,
      name: "Super Admin",
      role: "SUPER_ADMIN",
      emailVerified: true,
      requiresPasswordChange: false,
    });

    console.log("Successfully seeded super admin!");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

resetAndSeed();
