/**
 * READ-ONLY: what has an operator done to tenants' Google Drives, and when?
 *
 * The counterpart to `auditOperatorDriveAccess`. A trail nobody can read is
 * not a trail — it is a table — so the writer ships with its reader.
 *
 * Tenant admins see these rows in the app's own /audit-logs page alongside
 * their own activity, which is the point: operator access to their vault is
 * visible to them. This is the same view for whoever is on the server.
 *
 *   node scripts/print_operator_audit.mjs [limit]
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const limit = Number(process.argv[2] ?? 30);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT a.created_at, a.action, a.resource, a.details, t.name AS tenant
     FROM audit_logs a
     LEFT JOIN tenants t ON t.id = a.tenant_id
    WHERE a.action = 'google_drive.operator_inspect'
    ORDER BY a.created_at DESC
    LIMIT $1`,
  [limit],
);

if (rows.length === 0) {
  console.log('no operator Drive access recorded.');
} else {
  console.log(`${rows.length} most recent operator Drive access row(s):\n`);
  for (const r of rows) {
    console.log(`  ${r.created_at.toISOString()}  ${r.tenant ?? '(unknown tenant)'}`);
    console.log(`    ${r.details}`);
  }
}

await client.end();
