/**
 * /api/analysis — A FAILED ANALYSIS IS NEVER AN ANSWER
 *
 * Gemini 503'd ("model under heavy load"). `generateCategoryAnalysis` used to
 * swallow that into a placeholder object, and the route cached it over the last
 * good analysis and returned `success: true`. The page then showed "Analysis
 * failed due to an error." beside a green "No active issues" on every visit.
 *
 * These pin the two halves of the fix: a failure is an error response and is
 * not cached, and a failure an older build DID cache is treated as a miss.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const insert = vi.fn(() => ({ values: async () => {} }));
const update = vi.fn(() => ({ set: () => ({ where: async () => {} }) }));
vi.mock('@/lib/db', () => ({
  db: {
    query: { aiAnalysisCache: { findFirst: (...a: any[]) => findFirst(...(a as [])) } },
    insert: (...a: any[]) => insert(...(a as [])),
    update: (...a: any[]) => update(...(a as [])),
  },
  withTenant: async (_t: string, cb: any) => cb({}),
}));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN' })),
  hasCompanyAccess: vi.fn(async () => true),
  hasPersonalAccess: vi.fn(() => true),
}));
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));

vi.mock('@/lib/records/handler', () => ({
  companyIdFromRequest: () => null,
  recordContextFor: async () => ({ keys: [{ moduleKey: 'health_medical', documentKey: 'records_prescriptions' }] }),
  listRecords: async () => ({
    records: [{ id: 'r1', title: 'OUTPATIENT PRESCRIPTION', categoryName: 'Prescriptions', fields: {} }],
    total: 1,
    truncated: false,
  }),
}));

const generateCategoryAnalysis = vi.fn();
vi.mock('@/lib/ai', () => ({
  generateCategoryAnalysis: (...a: any[]) => generateCategoryAnalysis(...(a as [])),
}));

const { GET } = await import('@/app/api/analysis/route');
const { AI_ERROR_MESSAGES } = await import('@/lib/aiErrors');

const req = (qs = '') => new Request(`http://localhost/api/analysis?category=medical${qs}`);

beforeEach(() => {
  findFirst.mockReset();
  insert.mockClear();
  update.mockClear();
  generateCategoryAnalysis.mockReset();
});

describe('/api/analysis failure handling', () => {
  it('returns the overload message as a 503 and caches nothing', async () => {
    findFirst.mockResolvedValue({ id: 'c1', analysisData: { summary: 'the last good answer' } });
    generateCategoryAnalysis.mockRejectedValue(
      Object.assign(new Error('overloaded'), { errorCode: 'MODEL_OVERLOADED' }),
    );

    const res = await GET(req('&refresh=true'));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.errorCode).toBe('MODEL_OVERLOADED');
    expect(body.error).toBe(AI_ERROR_MESSAGES.MODEL_OVERLOADED);
    expect(body.success).toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('treats a cached failure as a miss and regenerates', async () => {
    findFirst.mockResolvedValue({
      id: 'c1',
      analysisData: { error: 'old failure', summary: 'Analysis failed due to an error.', itemsAnalysis: [] },
    });
    generateCategoryAnalysis.mockResolvedValue({
      summary: 'One outpatient prescription.', recommendations: [], itemsAnalysis: [],
    });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(body.analysis.summary).toBe('One outpatient prescription.');
    expect(generateCategoryAnalysis).toHaveBeenCalledTimes(1);
    // The poisoned row is overwritten with the good answer, not duplicated.
    expect(update).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('never caches a returned failure placeholder', async () => {
    findFirst.mockResolvedValue(undefined);
    generateCategoryAnalysis.mockResolvedValue({ error: 'x', summary: 'Analysis failed due to an error.' });

    const res = await GET(req());

    expect(res.status).toBe(502);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
