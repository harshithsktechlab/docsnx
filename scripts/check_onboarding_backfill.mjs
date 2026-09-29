/**
 * Pre-flight for the onboarding gate: who would it lock out?
 *
 * `requireOnboarded` refuses every record route for a tenant whose
 * `has_completed_onboarding` is false. That is correct for a tenant genuinely
 * mid-wizard and wrong for one that predates the flag or was seeded around it —
 * so count them, and show what each actually has, BEFORE the gate ships.
 *
 * Read-only.
 */
import { config } from 'dotenv';
import pg from 'pg';

// Same two lines every sibling script uses — the local file first, then any
// process-level defaults.
config({ path: '.env' + '.local' });
config();

const url = (process.env.DATABASE_URL || '').replace(/\?schema=[^&]*/, '');
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows: totals } = await client.query(
  'select has_completed_onboarding, count(*)::int from tenants group by 1 order by 1',
);
console.log('--- tenants by onboarding state ---');
console.table(totals);

const { rows: pending } = await client.query(`
  select t.id, t.name, t.account_type, t.google_drive_enabled,
         (t.google_drive_tokens is not null) as has_tokens,
         t.created_at::date as created,
         (select count(*)::int from users u where u.tenant_id = t.id and u.deleted_at is null) as users,
         (select count(*)::int from documents d where d.tenant_id = t.id and d.deleted_at is null) as documents
    from tenants t
   where t.has_completed_onboarding = false
   order by t.created_at
`);
console.log('--- tenants the gate would close ---');
console.table(pending);
console.log(
  '\nA row with documents or several users is a LIVE tenant that merely never'
  + '\nfinished the wizard — backfill it to true before shipping the gate.',
);

await client.end();
