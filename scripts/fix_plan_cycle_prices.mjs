/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ONE-OFF: move the Combo plan's price into the column that matches its   ║
 * ║  term, and clear the USD zero that was giving it away                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/fix_plan_cycle_prices.mjs          # dry run, prints the plan
 *   node scripts/fix_plan_cycle_prices.mjs --apply  # writes, in a transaction
 *
 * ── WHAT IS WRONG ──────────────────────────────────────────────────────────
 * "Combo (Personal + Business)" runs for 365 days but carries its ₹3,499 in the
 * MONTHLY price column, and nothing made those two agree. Two consequences, one
 * of them live:
 *
 *   1. The checkout offers it as "Monthly", and `expiryForCycle('MONTHLY')`
 *      grants one month — a year's price for thirty days.
 *
 *   2. `price_usd` is 0.00. `cyclePrice` reads `Number(plan.priceUsd || 0)` for
 *      a monthly USD line, so switching the checkout to USD prices the plan at
 *      $0 — which trips the `amountInPaise <= 0` branch in create-order and
 *      APPLIES THE PLAN FOR FREE, invoice and all. Anyone who clicks "$ USD"
 *      gets a ₹3,499 plan for nothing.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *   price        3499.00 → NULL        (not sold monthly; it is not a month)
 *   price_yearly NULL    → 3499.00     (the term it actually runs for)
 *   price_usd    0.00    → NULL        (not sold in USD, like every sibling)
 *
 * The amount charged in INR does not change: ₹3,499 before, ₹3,499 after. Only
 * the term it buys, which becomes the 365 days the plan was always meant to be.
 *
 * ── SAFE ON THE BUILD THAT IS RUNNING NOW ──────────────────────────────────
 * The deployed bundle picks its default cycle from whichever price column is
 * filled, so with `price` NULL it opens on YEARLY and reads `price_yearly` —
 * the correct behaviour, without waiting for a deploy. The code guard in
 * src/lib/planCycles.ts then makes the bad combination unsellable for good.
 *
 * Deliberately NOT a drizzle migration: this is per-environment catalogue data,
 * not schema, and replaying it against a database whose plans differ would be
 * a price change nobody asked for.
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env.local' });
config();

const APPLY = process.argv.includes('--apply');

/** The row to correct, by id — never by name, which an admin can edit. */
const PLAN_ID = 'd9929840-b7df-4365-9750-202bc1530b41';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, ''),
});
await client.connect();

const show = (p) => {
  console.log(`    name          ${p.name}`);
  console.log(`    duration_days ${p.duration_days}`);
  console.log(`    price         ${p.price}`);
  console.log(`    price_yearly  ${p.price_yearly}`);
  console.log(`    price_usd     ${p.price_usd}`);
};

const SELECT = `
  SELECT id, name, is_active, duration_days, price, price_yearly, price_usd
    FROM subscription_plans WHERE id = $1
`;

const { rows: before } = await client.query(SELECT, [PLAN_ID]);
if (before.length === 0) {
  console.error(`✗ No plan with id ${PLAN_ID}. Nothing done.`);
  await client.end();
  process.exit(1);
}

console.log('BEFORE:');
show(before[0]);

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write the change.');
  await client.end();
  process.exit(0);
}

try {
  await client.query('BEGIN');

  /**
   * Guarded by the values being replaced, so a second run — or a row an admin
   * has since corrected by hand — changes nothing rather than overwriting a
   * newer price with this script's assumptions.
   */
  const { rows: updated } = await client.query(`
    UPDATE subscription_plans
       SET price        = NULL,
           price_yearly = $2,
           price_usd    = NULL,
           updated_at   = now()
     WHERE id = $1
       AND price IS NOT NULL
       AND price_yearly IS NULL
    RETURNING id, name, is_active, duration_days, price, price_yearly, price_usd
  `, [PLAN_ID, before[0].price]);

  if (updated.length === 0) {
    await client.query('ROLLBACK');
    console.log('\n· Already corrected (or changed since it was read). Nothing written.');
    await client.end();
    process.exit(0);
  }

  // Prove the plan can now actually be sold: an annual term with an annual
  // price, and no monthly or USD figure to be read as zero.
  const p = updated[0];
  if (p.price !== null || p.price_usd !== null || Number(p.price_yearly) !== Number(before[0].price)) {
    await client.query('ROLLBACK');
    console.error('\n✗ Post-check failed — rolled back.');
    show(p);
    await client.end();
    process.exit(1);
  }

  await client.query('COMMIT');

  console.log('\nAFTER:');
  show(p);
  console.log('\n✓ Committed. ₹ price unchanged; it now buys the 365 days it runs for.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\n✗ Rolled back:', err.message);
  await client.end();
  process.exit(1);
}

await client.end();
