/**
 * READ-ONLY: which subscription plans can actually be deleted, and why not?
 *
 *   node scripts/check_plan_refs.mjs
 *
 * Mirrors the three refusals in permanentlyDelete() in
 * src/app/api/admin/plans/[id]/route.ts: a plan that is still active, one that
 * is the default for its account type, and one that any tenant, payment or
 * discount code still points at.
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env.local' });
config();

// `?schema=` is a Prisma-ism the pg driver does not understand.
const url = process.env.DATABASE_URL.replace(/\?schema=.*$/, '');
const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(`
  SELECT p.id, p.name, p.is_active, p.is_default, p.applies_to, p.price,
    (SELECT count(*) FROM tenants t
      WHERE t.subscription_plan_id = p.id OR t.business_plan_id = p.id) AS tenant_refs,
    (SELECT count(*) FROM payments pm WHERE pm.plan_id = p.id)      AS payment_refs,
    (SELECT count(*) FROM discount_codes d WHERE d.plan_id = p.id)  AS discount_refs
  FROM subscription_plans p
  ORDER BY p.is_active DESC, p.price NULLS LAST
`);

for (const r of rows) {
  const blockers = [];
  if (r.is_active) blockers.push('active');
  if (r.is_default) blockers.push('default');
  if (+r.tenant_refs) blockers.push(`${r.tenant_refs} tenant`);
  if (+r.payment_refs) blockers.push(`${r.payment_refs} payment`);
  if (+r.discount_refs) blockers.push(`${r.discount_refs} discount`);
  console.log(
    (r.is_active ? 'ACTIVE  ' : 'inactive') +
    (r.is_default ? ' DEFAULT' : '       ') +
    ` ${String(r.applies_to).padEnd(9)} ${String(r.name).padEnd(28)}` +
    (blockers.length ? ` blocked: ${blockers.join(', ')}` : ' DELETABLE'),
  );
}
console.log(`\n${rows.length} plans`);
await client.end();
