// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * "Recalculate past usage" (Admin → AI Settings). The SQL runs against Postgres
 * on the dev database; what is pinned here is what must hold whatever the data
 * is: which rows are eligible, that every value is bound, that a preview never
 * writes, and that applying leaves exactly one audit row.
 */
const dialect = new PgDialect();
const render = (q: any) => dialect.sqlToQuery(q);

const executed: any[] = [];
const audited: any[] = [];
let configMultiplier: string | null = '3.00';
let previewRow: any = {};

function execute(q: any) {
  const { sql } = render(q);
  executed.push(q);
  if (sql.includes('FROM system_configs')) {
    return Promise.resolve({ rows: configMultiplier === null ? [] : [{ ai_cost_multiplier: configMultiplier }] });
  }
  if (sql.trim().startsWith('SELECT')) return Promise.resolve({ rows: [previewRow] });
  return Promise.resolve({ rows: [] });
}

vi.mock('../src/lib/db', () => {
  const client = { execute: (q: any) => execute(q) };
  return { db: { ...client, transaction: async (fn: any) => fn(client) } };
});
vi.mock('../src/lib/audit', async () => ({
  writeAudit: vi.fn(async (entry: any) => { audited.push(entry); }),
  ...(await vi.importActual<any>('../src/lib/auditActions')),
}));

const actor = { id: 'admin-1', tenantId: 't1' };
const updates = () => executed.map(render).filter((r) => r.sql.trim().startsWith('UPDATE'));

beforeEach(() => {
  executed.length = 0;
  audited.length = 0;
  configMultiplier = '3.00';
  previewRow = {
    rows: '64', final_before: '3.5500', final_after: '5.3250', previous: ['2.00'],
    skipped_no_inr: '52', skipped_pre_tracking: '0',
  };
});

describe('recalcAiUsage — preview', () => {
  it('reports what would move and writes nothing', async () => {
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    const r = await recalcAiUsage({}, { apply: false });
    expect(r).toMatchObject({
      multiplier: 3, rows: 64, finalBefore: 3.55, finalAfter: 5.325,
      previousMultipliers: [2], skippedNoInr: 52, skippedPreTracking: 0, applied: false,
    });
    expect(updates()).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it('only ever selects rows that have both a Gemini ₹ figure and a recorded multiplier', async () => {
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    await recalcAiUsage({}, { apply: false });
    const select = executed.map(render).find((r) => r.sql.includes('tenant_ai_usages'))!;
    expect(select.sql).toContain('u.cost_inr IS NOT NULL');
    expect(select.sql).toContain('u.cost_multiplier IS NOT NULL');
  });

  it('returns null when no multiplier is configured', async () => {
    configMultiplier = null;
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    expect(await recalcAiUsage({}, { apply: false })).toBeNull();
  });

  it('reads a numeric[] that arrives as text', async () => {
    previewRow = { ...previewRow, previous: '{2.00,2.50}' };
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    expect((await recalcAiUsage({}, { apply: false }))!.previousMultipliers).toEqual([2, 2.5]);
  });
});

describe('recalcAiUsage — apply', () => {
  it('updates once, with every value bound, and writes one audit row', async () => {
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    const evil = "x'; DROP TABLE tenants; --";
    const r = await recalcAiUsage({ from: '2026-10-01', to: '2026-10-29', model: evil }, { apply: true, actor });
    expect(r!.applied).toBe(true);

    const [update, ...rest] = updates();
    expect(rest).toHaveLength(0);
    expect(update.sql).not.toContain('DROP TABLE');
    expect(update.params).toEqual(expect.arrayContaining([evil, '2026-10-01', '2026-10-29', '3.00']));
    expect(update.sql).toContain("AT TIME ZONE 'Asia/Kolkata'");

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: 'ai.recalculate_usage', tenantId: 't1', userId: 'admin-1', entityType: 'tenant_ai_usages',
    });
    expect(audited[0].details).toContain('64 calls (2026-10-01 to 2026-10-29)');
    expect(audited[0].details).toContain('×2 → ×3');
    expect(audited[0].details).toContain('₹3.55 → ₹5.33');
  });

  it('does not update or audit when nothing would change', async () => {
    previewRow = { ...previewRow, rows: '0', final_before: '0', final_after: '0', previous: [] };
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    const r = await recalcAiUsage({}, { apply: true, actor });
    expect(r!.rows).toBe(0);
    expect(updates()).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it('refuses to apply without an actor', async () => {
    const { recalcAiUsage } = await import('../src/lib/aiUsageRecalc');
    await expect(recalcAiUsage({}, { apply: true })).rejects.toThrow(/actor/);
  });
});
