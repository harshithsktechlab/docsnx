/**
 * /api/analysis — REFRESHING IS A PERMISSION THE TENANT ADMIN GRANTS
 *
 * A fresh analysis is a billed model call against the workspace's credits, so
 * it needs `ai_analysis` → `add`. Reading what is already saved does not: a
 * member set to View only still sees their analysis, and is told — by the
 * `canRefresh` flag and the 403's `errorCode` — why the button will not run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const insert = vi.fn(() => ({ values: async () => {} }));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      aiAnalysisCache: { findFirst: (...a: any[]) => findFirst(...(a as [])) },
      systemConfigs: { findFirst: async () => ({ aiCostCategoryAnalysis: '2.00' }) },
    },
    insert: (...a: any[]) => insert(...(a as [])),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
  withTenant: async (_t: string, cb: any) => cb({}),
}));

const hasPermission = vi.fn();
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'STANDARD' })),
  hasCompanyAccess: vi.fn(async () => true),
  hasPersonalAccess: vi.fn(() => true),
  hasPermission: (...a: any[]) => hasPermission(...(a as [])),
}));
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));
vi.mock('@/lib/records/handler', () => ({
  companyIdFromRequest: () => null,
  recordContextFor: async () => ({ keys: [{ moduleKey: 'health_medical', documentKey: 'records_prescriptions' }] }),
  listRecords: async () => ({ records: [], total: 0, truncated: false }),
}));

const generateCategoryAnalysis = vi.fn();
vi.mock('@/lib/ai', () => ({
  generateCategoryAnalysis: (...a: any[]) => generateCategoryAnalysis(...(a as [])),
}));

const { GET } = await import('@/app/api/analysis/route');

const req = (qs = '') => new Request(`http://localhost/api/analysis?category=medical${qs}`);

beforeEach(() => {
  findFirst.mockReset();
  insert.mockClear();
  hasPermission.mockReset();
  generateCategoryAnalysis.mockReset();
});

describe('/api/analysis refresh permission', () => {
  it('refuses a refresh without ai_analysis:add, and calls no model', async () => {
    hasPermission.mockResolvedValue(false);

    const res = await GET(req('&refresh=true'));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.errorCode).toBe('NO_REFRESH_PERMISSION');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'ai_analysis', 'add');
    expect(generateCategoryAnalysis).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('still serves the saved analysis, flagged as not refreshable', async () => {
    hasPermission.mockResolvedValue(false);
    findFirst.mockResolvedValue({ id: 'c1', analysisData: { summary: 'saved' }, updatedAt: new Date() });

    const res = await GET(req('&cacheOnly=true'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.analysis.summary).toBe('saved');
    expect(body.canRefresh).toBe(false);
  });

  it('reports the empty state as not refreshable, without a 403', async () => {
    hasPermission.mockResolvedValue(false);
    findFirst.mockResolvedValue(undefined);

    const body = await (await GET(req('&cacheOnly=true'))).json();

    expect(body.success).toBe(true);
    expect(body.analysis).toBeNull();
    expect(body.canRefresh).toBe(false);
  });

  it('runs the analysis when the grant is there', async () => {
    hasPermission.mockResolvedValue(true);
    findFirst.mockResolvedValue(undefined);
    generateCategoryAnalysis.mockResolvedValue({ summary: 'fresh' });

    const res = await GET(req('&refresh=true'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.analysis.summary).toBe('fresh');
    expect(body.canRefresh).toBe(true);
    expect(generateCategoryAnalysis).toHaveBeenCalledOnce();
  });
});
