/**
 * Restates past AI usage at the final-cost multiplier now saved in
 * system_configs — the "Recalculate past usage" button on Admin → AI Settings.
 *
 * Every `tenant_ai_usages` row keeps the multiplier in force when it ran, so a
 * change to the setting leaves history alone. This is the one deliberate way to
 * move it, and it only ever runs when a super admin asks.
 *
 * ── WHICH ROWS ─────────────────────────────────────────────────────────────
 * Only rows with BOTH `cost_inr` and `cost_multiplier`:
 *   · no `cost_inr` — no INR rate was set when the call ran. Nothing to multiply,
 *     and inventing a rate here would be a guess presented as a record.
 *   · no `cost_multiplier` — written between 0075 and 0076. aiUsageReport.ts
 *     reads `cost_multiplier IS NOT NULL` as "written after 0076, so an
 *     unlinked row really was a discarded read". Stamping one on an older row
 *     would reclassify it as AI work the user threw away.
 * Both are counted and reported rather than silently skipped.
 *
 * The multiplier is READ here, never passed in: it is whatever new calls are
 * being priced at, so the screen cannot disagree with it.
 */
import { sql } from 'drizzle-orm';
import { db } from './db';
import { writeAudit, ACTIONS, auditSentence } from './audit';
import { parseCostMultiplier } from './aiKeyManager';
import { whereFor, type AiUsageFilters } from './aiUsageReport';

export interface RecalcResult {
  multiplier: number;
  /** Rows whose final cost would change (or did). */
  rows: number;
  finalBefore: number;
  finalAfter: number;
  /** Multipliers those rows carried until now, e.g. [2]. */
  previousMultipliers: number[];
  /** In range but with no Gemini ₹ figure, so untouched. */
  skippedNoInr: number;
  /** In range but written before final costs existed, so untouched. */
  skippedPreTracking: number;
  applied: boolean;
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/** The platform's current final-cost multiplier, or null if none is configured. */
export async function currentMultiplier(client: Pick<typeof db, 'execute'> = db): Promise<number | null> {
  const rows = rowsOf(await client.execute(sql`SELECT ai_cost_multiplier FROM system_configs LIMIT 1`));
  return parseCostMultiplier(rows[0]?.ai_cost_multiplier);
}

/** Rows a recalculation at `multiplier` would move, over alias `u`. */
const MOVES = (multiplier: number) => sql`
  u.cost_inr IS NOT NULL
  AND u.cost_multiplier IS NOT NULL
  AND (u.cost_multiplier <> ${multiplier.toFixed(2)}::numeric
       OR u.final_cost_inr IS DISTINCT FROM round(u.cost_inr * ${multiplier.toFixed(2)}::numeric, 4))`;

/** A numeric[] arrives as an array from node-pg, but as '{2.00,3.00}' text through some drivers. */
function numberList(value: unknown): number[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.replace(/[{}]/g, '').split(',').filter(Boolean) : [];
  return items.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

function summarise(multiplier: number, row: any, applied: boolean): RecalcResult {
  return {
    multiplier,
    rows: Number(row?.rows ?? 0),
    finalBefore: Number(row?.final_before ?? 0),
    finalAfter: Number(row?.final_after ?? 0),
    previousMultipliers: numberList(row?.previous),
    skippedNoInr: Number(row?.skipped_no_inr ?? 0),
    skippedPreTracking: Number(row?.skipped_pre_tracking ?? 0),
    applied,
  };
}

function describeRange(f: AiUsageFilters): string {
  if (f.from && f.to) return `${f.from} to ${f.to}`;
  if (f.from) return `from ${f.from}`;
  if (f.to) return `up to ${f.to}`;
  return 'all usage';
}

/**
 * Previews, or applies, the restatement over the rows `filters` selects.
 * `actor` is the super admin, for the audit row; it is only used when applying.
 */
export async function recalcAiUsage(
  filters: AiUsageFilters,
  opts: { apply: boolean; actor?: { id: string; tenantId: string }; req?: Request },
): Promise<RecalcResult | null> {
  const multiplier = await currentMultiplier();
  if (!multiplier) return null;

  const where = whereFor(filters);

  const preview = async (client: Pick<typeof db, 'execute'>) => rowsOf(await client.execute(sql`
    SELECT
      count(*) FILTER (WHERE ${MOVES(multiplier)})                              AS rows,
      COALESCE(sum(u.final_cost_inr) FILTER (WHERE ${MOVES(multiplier)}), 0)    AS final_before,
      COALESCE(sum(round(u.cost_inr * ${multiplier.toFixed(2)}::numeric, 4))
               FILTER (WHERE ${MOVES(multiplier)}), 0)                          AS final_after,
      COALESCE(array_agg(DISTINCT u.cost_multiplier) FILTER (WHERE ${MOVES(multiplier)}), '{}') AS previous,
      count(*) FILTER (WHERE u.cost_inr IS NULL)                                AS skipped_no_inr,
      count(*) FILTER (WHERE u.cost_inr IS NOT NULL AND u.cost_multiplier IS NULL) AS skipped_pre_tracking
    FROM tenant_ai_usages u
    WHERE ${where}`))[0];

  if (!opts.apply) return summarise(multiplier, await preview(db), false);

  if (!opts.actor) throw new Error('recalcAiUsage: an actor is required to apply.');
  const actor = opts.actor;

  return db.transaction(async (tx) => {
    // Measured inside the transaction, so the audit row describes exactly what
    // this UPDATE moved and not what a preview saw a minute earlier.
    const before = summarise(multiplier, await preview(tx as any), true);

    if (before.rows > 0) {
      await tx.execute(sql`
        UPDATE tenant_ai_usages u
           SET cost_multiplier = ${multiplier.toFixed(2)}::numeric,
               final_cost_inr  = round(u.cost_inr * ${multiplier.toFixed(2)}::numeric, 4)
         WHERE ${where} AND ${MOVES(multiplier)}`);

      await writeAudit({
        tenantId: actor.tenantId,
        userId: actor.id,
        action: ACTIONS.ai.recalculate_usage,
        details: auditSentence('recalculate_usage', {
          kind: 'AI usage final cost',
          note: [
            `${before.rows} calls (${describeRange(filters)})`,
            `multiplier ${before.previousMultipliers.map((m) => `×${m}`).join('/')} → ×${multiplier}`,
            `final ₹${before.finalBefore.toFixed(2)} → ₹${before.finalAfter.toFixed(2)}`,
          ].join(', '),
        }),
        req: opts.req,
        entityType: 'tenant_ai_usages',
      }, tx as any);
    }

    return before;
  });
}
