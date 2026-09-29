/**
 * READ-ONLY: reproduce the inputs POST /api/companies uses for its quota
 * decision, for a given tenant.
 *
 * Sets `app.tenant_id` first — several of these tables are RLS-FORCED, and a
 * session without it reads zero rows SILENTLY rather than erroring, which looks
 * exactly like "the tenant does not exist".
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const { Client } = pg;
const url = (process.env.DATABASE_URL || '').replace(/[?&]schema=[^&]*/, '');
const tenantId = process.argv[2];
if (!tenantId) {
  console.error('usage: node scripts/check_company_quota.mjs <tenantId>');
  process.exit(1);
}

const c = new Client({ connectionString: url });
await c.connect();

const who = await c.query(
  `select current_user, session_user,
          (select rolsuper from pg_roles where rolname = current_user) as is_super`,
);
console.log('connected as:', who.rows[0]);

const rls = await c.query(
  `select relname, relrowsecurity, relforcerowsecurity
     from pg_class
    where relname in ('tenants', 'tenant_addons', 'companies', 'addons')
      and relkind = 'r'
    order by relname`,
);
console.log('rls:', rls.rows);

await c.query(`select set_config('app.tenant_id', $1, false)`, [tenantId]);

const t = await c.query(
  `select id, name, account_type, business_plan_id, business_plan_expiry,
          extra_companies, has_completed_onboarding, is_active
     from tenants where id = $1`,
  [tenantId],
);
console.log('tenant:', t.rows[0]);

const bp = t.rows[0]?.business_plan_id;
if (bp) {
  const p = await c.query(
    `select id, name, max_companies, max_members, max_members_per_company, is_active
       from subscription_plans where id = $1`,
    [bp],
  );
  console.log('business plan:', p.rows[0]);
} else {
  console.log('business plan: NONE');
}

const live = await c.query(
  `select count(*)::int as live from companies
    where tenant_id = $1 and deleted_at is null`,
  [tenantId],
);
console.log('live companies:', live.rows[0].live);

const addons = await c.query(
  `select ta.addon_id, ta.quantity, ta.is_active, ta.expires_at,
          a.name, a.extra_companies, a.extra_members
     from tenant_addons ta join addons a on a.id = ta.addon_id
    where ta.tenant_id = $1`,
  [tenantId],
);
console.log('addons:', addons.rows);

await c.end();
