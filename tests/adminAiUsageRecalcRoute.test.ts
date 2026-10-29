// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/admin/ai-usage/recalculate — the gate, the default (preview, never
 * apply), and that a date that does not parse is refused rather than quietly
 * widening the range to "all usage".
 */
let sessionUser: any = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };
const recalc = vi.fn(async (_filters: any, _opts: any) => ({ multiplier: 3, rows: 1, applied: false }));

vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn(async () => sessionUser) }));
vi.mock('@/lib/aiUsageRecalc', () => ({ recalcAiUsage: (f: any, o: any) => recalc(f, o) }));

const { POST } = await import('@/app/api/admin/ai-usage/recalculate/route');

const post = (body: unknown) => POST(new Request('http://x/api/admin/ai-usage/recalculate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

beforeEach(() => {
  recalc.mockClear();
  sessionUser = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };
});

describe('POST /api/admin/ai-usage/recalculate', () => {
  it('refuses anyone who is not a super admin', async () => {
    sessionUser = { id: 'u1', tenantId: 't1', role: 'ADMIN' };
    expect((await post({ apply: true })).status).toBe(403);
    expect(recalc).not.toHaveBeenCalled();
  });

  it('previews unless apply is exactly true', async () => {
    await post({});
    await post({ apply: 'true' });
    await post({ apply: 1 });
    expect(recalc.mock.calls.map((c) => c[1].apply)).toEqual([false, false, false]);

    await post({ apply: true });
    expect(recalc.mock.calls[3][1].apply).toBe(true);
    expect(recalc.mock.calls[3][1].actor).toEqual({ id: 'admin-1', tenantId: 't1' });
  });

  it('passes the range through, and null when blank', async () => {
    await post({ from: '2026-10-01', to: '2026-10-29' });
    expect(recalc.mock.calls[0][0]).toEqual({ from: '2026-10-01', to: '2026-10-29' });
    await post({});
    expect(recalc.mock.calls[1][0]).toEqual({ from: null, to: null });
  });

  it('refuses a malformed or reversed range instead of widening it', async () => {
    expect((await post({ from: 'yesterday' })).status).toBe(400);
    expect((await post({ from: '2026-10-29', to: '2026-10-01' })).status).toBe(400);
    expect(recalc).not.toHaveBeenCalled();
  });

  it('reports a missing multiplier', async () => {
    recalc.mockResolvedValueOnce(null as any);
    expect((await post({})).status).toBe(400);
  });
});
