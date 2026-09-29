/**
 * READ-ONLY. Counts existing rows whose "Belongs to" / assignee is not a member
 * of the workspace the row lives in — the state the workspace-member checks
 * (src/lib/records/workspaceMembers.ts) now refuse to create.
 *
 *   household row (company_id IS NULL)  → holder must be a TENANT_ADMIN or a
 *                                         member with account_scope 'personal'
 *   company row                         → holder must be a TENANT_ADMIN or hold
 *                                         a company_access row for that company
 *
 * Prints counts per table and tenant, plus row ids — no names, no credentials.
 * Nothing is written. Fixing a row is a separate, deliberate step.
 *
 * Usage: node scripts/report_cross_workspace_holders.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: ['', 'env', 'local'].join('.') });
config();

const TABLES = [
  { table: 'documents', column: 'holder_id', live: 'r.deleted_at IS NULL' },
  { table: 'passwords', column: 'holder_id', live: 'r.deleted_at IS NULL' },
  { table: 'todos', column: 'assignee_id', live: 'true' },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  for (const { table, column, live } of TABLES) {
    // The app role is subject to RLS, so read as each tenant in turn.
    const { rows: tenants } = await client.query(`SELECT id FROM tenants`);
    const found = [];
    // Proof the read saw anything at all: under RLS a wrong tenant context
    // answers zero rows silently, which would read as "all clean".
    let scanned = 0;
    for (const { id: tenantId } of tenants) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const { rows: [{ n }] } = await client.query(
        `SELECT count(*)::int AS n FROM ${table} r WHERE r.tenant_id = $1 AND r.${column} IS NOT NULL AND ${live}`,
        [tenantId]);
      scanned += n;
      const { rows } = await client.query(`
        SELECT r.id, r.company_id, r.${column} AS holder_id
          FROM ${table} r
          JOIN users u ON u.id = r.${column}
         WHERE r.tenant_id = $1
           AND ${live}
           AND u.role <> 'TENANT_ADMIN'
           AND (
             (r.company_id IS NULL AND u.account_scope <> 'personal')
             OR (r.company_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM company_access ca
                    WHERE ca.user_id = u.id AND ca.company_id = r.company_id))
           )`, [tenantId]);
      for (const row of rows) found.push({ tenantId, ...row });
    }
    console.log(`\n${table}.${column}: ${found.length} of ${scanned} assigned row(s) outside their workspace (${tenants.length} tenants)`);
    if (found.length) console.table(found);
  }
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
