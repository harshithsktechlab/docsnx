const pg = require('pg');
// This project's env file is the `.local` one; a bare dotenv.config() reads only
// the plain `.env`, which does not exist here — so DATABASE_URL came back
// undefined and the pool failed with the baffling
// `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`.
// Mirrors scripts/loadEnv.ts, which the TypeScript scripts import.
require('dotenv').config({ path: '.env' + '.local' });
require('dotenv').config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Tables with a `tenant_id` of their own.
 *
 * Eight entries left here when the fifteen per-module record tables were
 * dropped: their records are `documents` rows now, and `documents` carries the
 * policy. That is a net SECURITY GAIN, not just tidying — seven of those tables
 * (tax_compliances, wills_estates, loans_debts, utility_bills,
 * corporate_compliances, employment_payrolls, credit_cards) never had a policy
 * at all, and now cannot: they no longer exist.
 *
 * A name in this list that is not a real table makes CREATE POLICY fail, and
 * because the whole script runs in one transaction that rolls back EVERY
 * policy. So this list is trimmed BEFORE the tables are dropped, never after.
 */
const tenantScopedTables = [
  'users',
  'documents',
  'passwords',
  'audit_logs',
  'tenant_ai_usages',
  // The AI credit ledger. Append-only and tenant-owned: without a policy one
  // tenant's forgotten predicate would expose another's spending history.
  'credit_transactions',
  'emergency_contacts',
  'todos',
  'notifications',
  'payments',
  // Vault. These hold wrapped key material and Drive pointers — a missing
  // policy here would let one tenant enumerate another's wrapped keys.
  'tenant_encryption_keys',
  'user_vault_keys',
  'vault_json_files',
  // The business account's companies. A missing policy here would let one
  // tenant enumerate another's company names — and, through the ids, address
  // their Drive folders.
  'companies',
  // A company's own identity: legal name, CIN, registered address, and the
  // encrypted GST/PAN/TAN. It carries its own tenant_id precisely so it can
  // take this simple policy rather than the EXISTS shape below.
  'company_profiles'
];

/**
 * Hybrid global + tenant reference tables — a table whose tenant_id is NULLable,
 * where NULL means "a system row every tenant can read". The standard policy
 * `tenant_id = current_setting(...)` would make every seeded baseline row
 * invisible to every tenant, so such a table MUST NOT join tenantScopedTables
 * above. The USING/WITH CHECK asymmetry is the point — everyone READS global
 * rows, nobody WRITES one through a tenant session.
 *
 * Currently EMPTY, and that is the correct state, not an oversight. Both former
 * members are now plain global tables with no tenant column and therefore no
 * policy: `document_categories` lost its tenant_id in drizzle/0006 and
 * `document_category_fields` in drizzle/0008. Registering either would create a
 * policy over a column that does not exist, which fails at CREATE POLICY time
 * and rolls back this whole script.
 *
 * The loop below is retained for the next table that genuinely needs the shape.
 */
const hybridGlobalTenantTables = [];

/**
 * Tables with NO tenant_id of their own, scoped through `user_id -> users`.
 *
 * `permissions` and `company_access`. Both answer a question about a USER, and
 * neither carries a tenant column. `permissions` was previously listed as
 * tenant-scoped,
 * which made `CREATE POLICY ... USING (tenant_id = ...)` fail with
 * `column "tenant_id" does not exist` on the SECOND table of the loop — and
 * because the whole script runs in one transaction, that rolled back
 * everything. This script therefore never applied a single policy.
 *
 * The EXISTS subquery reads `users`, which itself has FORCE RLS and its own
 * tenant policy, so it can only ever see the current tenant's rows — the
 * indirection does not widen anything.
 */
const userScopedTables = ['permissions', 'company_access'];

/**
 * `deleted_accounts` HAS a tenant_id and appears in NONE of the three lists
 * above. That is deliberate, not an oversight — do not "fix" it.
 *
 * It holds the name/phone/email of the members of a workspace that has been
 * erased, and it is the only thing that survives that erasure. The standard
 * policy `tenant_id = current_setting('app.tenant_id')::uuid` could never match
 * a single row: by the time a row exists its tenant does not, so no session can
 * set app.tenant_id to that value and the table would read as permanently empty
 * — including for the SUPER_ADMIN and the compliance query it exists to serve.
 *
 * What protects it instead: nothing selects from it (there is no read API), and
 * `name` / `phone_number` are stored as encryptField() ciphertext. See the
 * comment on `deletedAccounts` in src/db/schema.ts.
 */

async function applyRLS() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const table of tenantScopedTables) {
      console.log(`Enabling RLS on ${table}...`);
      
      // Enable RLS
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      
      // Drop existing policy if it exists
      await client.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
      
      // Create the tenant isolation policy
      await client.query(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
      `);
    }
    
    for (const table of userScopedTables) {
      console.log(`Enabling user-scoped RLS on ${table}...`);

      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      await client.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);

      await client.query(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (EXISTS (
          SELECT 1 FROM users u
           WHERE u.id = ${table}.user_id
             AND u.tenant_id = current_setting('app.tenant_id', true)::uuid
        ));
      `);
    }

    for (const table of hybridGlobalTenantTables) {
      console.log(`Enabling hybrid global+tenant RLS on ${table}...`);

      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      await client.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);

      await client.query(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
      `);
    }

    await client.query('COMMIT');
    console.log('✅ Successfully applied RLS policies to all tenant-scoped tables.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to apply RLS policies:', err);
  } finally {
    client.release();
    pool.end();
  }
}

applyRLS();
