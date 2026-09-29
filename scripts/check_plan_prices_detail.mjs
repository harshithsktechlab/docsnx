/**
 * READ-ONLY: the full price/term picture for every plan, INR and USD.
 *
 * Companion to check_plan_cycles.mjs, which reports only the INR contradiction.
 * Run it before and after fix_plan_cycle_prices.mjs — the printed values are
 * what the change can be reversed from.
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env.local' });
config();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, ''),
});
await client.connect();

const { rows } = await client.query(`
  SELECT id, name, is_active, applies_to, duration_days, is_lifetime,
         price, price_yearly, price_one_time,
         price_usd, price_yearly_usd, price_one_time_usd
    FROM subscription_plans
   ORDER BY is_active DESC, name
`);

for (const p of rows) {
  console.log(`${p.is_active ? '●' : '○'} ${p.name}  [${p.applies_to}]  id=${p.id}`);
  console.log(`    duration_days=${p.duration_days}  is_lifetime=${p.is_lifetime}`);
  console.log(`    INR  price=${p.price}  yearly=${p.price_yearly}  one_time=${p.price_one_time}`);
  console.log(`    USD  price=${p.price_usd}  yearly=${p.price_yearly_usd}  one_time=${p.price_one_time_usd}`);
}

await client.end();
