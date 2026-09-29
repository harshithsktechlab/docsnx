import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './src/db/schema';
import { hashPassword } from './src/lib/auth';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool, { schema });

async function main() {
  console.log('Connecting to DB at:', process.env.DATABASE_URL);
  
  // Truncate all tables
  const tableNames = [
    'user_devices',
    'discount_usages',
    'discount_codes',
    'ai_analysis_cache',
    'invoices',
    'payments',
    'tenant_addons',
    'addons',
    'subscription_plans',
    'trial_used_emails',
    'notifications',
    'todos',
    'contract_agreements',
    'warranty_amcs',
    'emergency_contacts',
    'tenant_ai_usages',
    'system_configs',
    'ai_api_keys',
    'api_keys',
    'audit_logs',
    'investments',
    'lic_mediclaims',
    'vehicles',
    'trading_demats',
    'bank_infos',
    'passwords',
    'medical_records',
    'documents',
    'profiles',
    'permissions',
    'users',
    'tenants'
  ];

  console.log('Truncating tables...');
  for (const tableName of tableNames) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "${tableName}" CASCADE;`));
      console.log(`Truncated ${tableName}`);
    } catch (e) {
      console.log(`Error truncating ${tableName}:`, e.message);
    }
  }

  console.log('Creating super admin tenant and user...');
  
  // Create system tenant
  const [tenant] = await db.insert(schema.tenants).values({
    name: 'System Tenant',
    isActive: true,
  }).returning();

  const passwordHash = await hashPassword('123456');

  // Create super admin
  await db.insert(schema.users).values({
    name: 'Super Admin',
    email: 'sunil@hsk.com',
    passwordHash: passwordHash,
    role: 'SUPER_ADMIN',
    tenantId: tenant.id,
  });

  console.log('Super admin created: sunil@hsk.com / 123456');
  
  // Also setup default system config
  await db.insert(schema.systemConfigs).values({
    platformName: 'DocsNX',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'user',
    smtpPassword: 'password',
    smtpFrom: 'noreply@example.com',
    aiCostRecordAnalysis: '1.00',
    aiCostCategoryAnalysis: '2.00',
    aiCostPortfolioAnalysis: '5.00',
    aiCostBulkScan: '10.00',
  });

  console.log('Database wiped successfully!');
  process.exit(0);
}

main().catch(console.error);
