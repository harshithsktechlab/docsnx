/**
 * READ-ONLY: which subscription plans are priced on a term they do not run for?
 *
 *   node scripts/check_plan_cycles.mjs
 *
 * A plan states its term twice — `duration_days` (how long it RUNS) and which
 * price columns are filled (what it costs per CYCLE) — and nothing made the two
 * agree. The checkout read only the prices, so a plan with `duration_days` 365
 * and its figure in the MONTHLY column was offered as "Monthly", and
 * `expiryForCycle('MONTHLY')` grants one month: a year's price for thirty days.
 *
 * `src/lib/planCycles.ts` now refuses to offer or sell that combination, so
 * nobody can be charged for it. This finds the rows to CORRECT, because until
 * they are fixed those plans simply have one fewer cycle on offer — and a plan
 * whose only populated column is the wrong one cannot be bought at all.
 *
 * The fix for each row is in Admin → Plans: move the figure out of the monthly
 * price and into the yearly one.
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
  SELECT name, price, price_yearly, price_one_time,
         duration_days, is_lifetime, is_active, applies_to
    FROM subscription_plans
   ORDER BY is_active DESC, name
`);

/** Mirrors MAX_MONTHLY_DAYS and `priced` in src/lib/planCycles.ts. */
const MAX_MONTHLY_DAYS = 45;
/** Zero is NOT a price: a zero line is applied without payment. */
const priced = (v) => v !== null && v !== undefined && v !== '' && Number(v) > 0;

const problems = [];
const unsellable = [];

for (const p of rows) {
  const lifetime = p.is_lifetime || !p.duration_days || p.duration_days <= 0;
  const monthlyTerm = !lifetime && p.duration_days <= MAX_MONTHLY_DAYS;

  // Untidy, not broken: the price sits in a column its term contradicts. The
  // product sells it on the term regardless (see `allowedCycles`), so this is
  // a housekeeping list, not a blocker.
  if (priced(p.price) && !monthlyTerm) problems.push(p);

  /**
   * Sellable means "carries a real price in this currency AT ALL" — the cycle
   * comes from `duration_days`, not from which column the figure is in. This
   * used to require the term's own column and so reported a false blocker for
   * every row in the list above.
   */
  const sellableInr = priced(p.price) || priced(p.price_yearly) || priced(p.price_one_time);
  if (p.is_active && !sellableInr) unsellable.push(p);
}

const money = (v) => (priced(v) ? `₹${Number(v).toLocaleString('en-IN')}` : '—');

console.log(`${rows.length} plan(s); ${rows.filter((r) => r.is_active).length} active\n`);

if (problems.length === 0) {
  console.log('✓ No plan carries a monthly price on a term longer than a month.');
} else {
  console.log(`⚠ ${problems.length} plan(s) priced monthly but running longer than ${MAX_MONTHLY_DAYS} days.`);
  console.log('  Each SELLS CORRECTLY — on the term it runs for — but the figure is in');
  console.log('  the wrong column. Tidy when convenient:\n');
  for (const p of problems) {
    console.log(`    ${p.name}${p.is_active ? '' : '  (inactive)'}`);
    console.log(`      runs ${p.duration_days} days · monthly ${money(p.price)} · yearly ${money(p.price_yearly)}`);
  }
}

if (unsellable.length > 0) {
  console.log(`\n⛔ ${unsellable.length} ACTIVE plan(s) now have no sellable cycle at all:\n`);
  for (const p of unsellable) {
    console.log(`    ${p.name} (${p.applies_to}) — runs ${p.duration_days} days, monthly ${money(p.price)}, yearly ${money(p.price_yearly)}`);
  }
  console.log('\n  These carry no usable price and are hidden from the billing grid.');
}

await client.end();
