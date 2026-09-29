/**
 * READ-ONLY: what the landing-page pricing cards will show for the live plans.
 *
 * Mirrors `cardPrice` in src/app/page.js — `priceIn` + `termCycle` in INR —
 * so the figures can be checked without a browser or a rebuild.
 */
import { config } from 'dotenv';
import pg from 'pg';
import { priceIn, termCycle } from '../src/lib/planCycles';

config({ path: '.env.local' });
config();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL!.replace(/\?schema=.*$/, ''),
});
await client.connect();

const { rows } = await client.query(`
  SELECT name, duration_days AS "durationDays", is_lifetime AS "isLifetime",
         price, price_yearly AS "priceYearly", price_one_time AS "priceOneTime",
         price_usd AS "priceUsd", price_yearly_usd AS "priceYearlyUsd", price_one_time_usd AS "priceOneTimeUsd"
    FROM subscription_plans WHERE is_active = true
`);

type Card = { name: string; amount: number; shown: string };

const cards: Card[] = [];
for (const plan of rows) {
  const amount = priceIn(plan, 'INR');
  if (amount === null) continue;
  const cycle = termCycle(plan);
  const label = amount === 0 ? 'Free' : `₹${amount.toLocaleString('en-IN')}`;
  const suffix = amount === 0 ? '' : cycle === 'YEARLY' ? '/yr' : cycle === 'MONTHLY' ? '/mo' : ' one-time';
  cards.push({ name: plan.name, amount, shown: label + suffix });
}
cards.sort((a, b) => a.amount - b.amount);

for (const c of cards) console.log(`${c.name.padEnd(24)} ${c.shown}`);
await client.end();
