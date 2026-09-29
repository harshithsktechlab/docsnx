/**
 * Sets the trial (default) subscription plan's AI credit allowance and backfills
 * the balance of existing tenants already on that plan.
 *
 * Why this exists: `subscription_plans.ai_credits` was 0 on the default plan and
 * no code path ever seeded `tenants.ai_credits_balance`, so every tenant sat at
 * zero credits and every AI action failed with INSUFFICIENT_CREDITS. The code
 * paths are fixed for new tenants; this repairs the ones already in the database.
 *
 * Safe to re-run: it only ever raises a balance toward the plan's allowance and
 * skips tenants that have paid.
 *
 * Usage:
 *   npx tsx src/scripts/setup-trial-credits.ts              # dry run (default)
 *   npx tsx src/scripts/setup-trial-credits.ts --apply
 *   npx tsx src/scripts/setup-trial-credits.ts --credits=200 --apply
 */
import { config } from 'dotenv';
import { Pool } from 'pg';

// DATABASE_URL lives in .env.local (Next.js loads it in dev and production alike).
config({ path: '.env.local' });
config({ path: '.env' });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const creditsArg = args.find((a) => a.startsWith('--credits='));
const TRIAL_CREDITS = creditsArg ? Number(creditsArg.split('=')[1]) : 100;

if (!Number.isInteger(TRIAL_CREDITS) || TRIAL_CREDITS < 0) {
  console.error(`Invalid --credits value: ${creditsArg}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Expected it in .env.local.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();

  console.log(`\nTrial AI credits setup — ${APPLY ? 'APPLY' : 'DRY RUN'} (target: ${TRIAL_CREDITS} credits)\n`);

  try {
    await client.query('BEGIN');

    // 1. Locate the default plan. Registration picks it by is_default, so more
    //    than one is ambiguous and is treated as a configuration error.
    const planRes = await client.query(
      `SELECT id, name, ai_credits, duration_days FROM subscription_plans WHERE is_default = true`
    );

    if (planRes.rowCount === 0) {
      throw new Error('No default subscription plan found (is_default = true). Nothing to do.');
    }
    if (planRes.rowCount! > 1) {
      throw new Error(`Found ${planRes.rowCount} default plans; expected exactly one. Fix this in /admin/plans first.`);
    }

    const plan = planRes.rows[0];
    console.log(`Default plan: '${plan.name}' (${plan.id})`);
    console.log(`  ai_credits:    ${plan.ai_credits} -> ${TRIAL_CREDITS}${plan.ai_credits === TRIAL_CREDITS ? ' (unchanged)' : ''}`);
    console.log(`  duration_days: ${plan.duration_days ?? 'null (falls back to 14 at signup)'}\n`);

    // 2. Set the plan allowance.
    if (plan.ai_credits !== TRIAL_CREDITS) {
      await client.query(`UPDATE subscription_plans SET ai_credits = $1 WHERE id = $2`, [TRIAL_CREDITS, plan.id]);
    }

    // 3. Find tenants on that plan whose balance is below the allowance and who
    //    have never completed a payment (a paying tenant's balance is whatever
    //    they bought — do not reset it).
    const candidatesRes = await client.query(
      `SELECT t.id, t.name, t.ai_credits_balance
         FROM tenants t
        WHERE t.subscription_plan_id = $1
          AND t.deleted_at IS NULL
          AND t.ai_credits_balance < $2
          AND NOT EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.tenant_id = t.id AND p.status = 'captured'
              )
        ORDER BY t.created_at`,
      [plan.id, TRIAL_CREDITS]
    );

    console.log(`Tenants to backfill: ${candidatesRes.rowCount}`);
    for (const t of candidatesRes.rows) {
      console.log(`  ${t.name} (${t.id}): ${t.ai_credits_balance} -> ${TRIAL_CREDITS}`);
    }

    if (candidatesRes.rowCount! > 0) {
      const ids = candidatesRes.rows.map((r: { id: string }) => r.id);

      await client.query(
        `UPDATE tenants SET ai_credits_balance = $1, updated_at = now() WHERE id = ANY($2::uuid[])`,
        [TRIAL_CREDITS, ids]
      );

      // One audit row per tenant, matching the mutation-logging convention.
      // Raw SQL because this runs outside the app, so it cannot call
      // writeAudit()/auditSentence() — the wording below is hand-matched to
      // what auditSentence('grant', ...) produces so the trail stays uniform.
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, details)
         SELECT t.id, NULL, 'credits.trial_granted',
                'Granted AI credits — ' || $1 || ' backfilled from the ' || $2 || ' plan.'
           FROM tenants t
          WHERE t.id = ANY($3::uuid[])`,
        [TRIAL_CREDITS, plan.name, ids]
      );
    }

    // 4. Report the resulting state before deciding whether to commit.
    const afterRes = await client.query(
      `SELECT t.name, COALESCE(p.name, '(no plan)') AS plan, t.ai_credits_balance
         FROM tenants t
         LEFT JOIN subscription_plans p ON p.id = t.subscription_plan_id
        WHERE t.deleted_at IS NULL
        ORDER BY t.ai_credits_balance DESC, t.created_at
        LIMIT 25`
    );
    console.log('\nResulting tenant balances (top 25):');
    console.table(afterRes.rows);

    if (APPLY) {
      await client.query('COMMIT');
      console.log('\nCommitted.\n');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back. Re-run with --apply to commit.\n');
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\nFailed, rolled back:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
