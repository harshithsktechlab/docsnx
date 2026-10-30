/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/modules/:m/:d/autofill — QUESTIONING THE USER'S PICK              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * With `checkCategory=1` the route classifies the document BEFORE reading its
 * fields, and when it clearly belongs elsewhere answers with a `mismatch` —
 * spending no field read on a category the user may be about to leave.
 *
 *  · no flag                → the old behaviour, no classify;
 *  · `skipCategoryCheck=1`  → the re-read after the user's answer, no classify;
 *  · a fit / an unsure      → fields as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cat = (id: string, moduleKey: string, documentKey: string, moduleName: string, documentName: string) =>
  ({ id, moduleKey, documentKey, moduleName, documentName });
const HEALTH = cat('aaaaaaaa-0000-4000-8000-000000000001', 'insurance', 'health_insurance', 'Insurance', 'Health insurance');
const PAN = cat('aaaaaaaa-0000-4000-8000-000000000002', 'identity', 'pan_card', 'Identity', 'PAN Card');
const INS_OTHER = cat('aaaaaaaa-0000-4000-8000-000000000003', 'insurance', 'other', 'Insurance', 'Other');
const ALL = [HEALTH, PAN, INS_OTHER];

vi.mock('@/lib/db', () => ({ db: {}, withTenant: async (_t: string, cb: any) => cb({}) }));

const permittedKeys = vi.fn(async () => [
  { moduleKey: 'insurance', documentKey: 'health_insurance' },
  { moduleKey: 'identity', documentKey: 'pan_card' },
]);
vi.mock('@/lib/records/handler', () => ({
  documentManagerContext: async () => ({ keys: await permittedKeys() }),
  withCategory: async (_req: Request, _key: unknown, _action: string, cb: any) =>
    cb({ user: { id: 'u1', tenantId: 't1', role: 'STANDARD' }, companyId: null }),
}));

vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: async () => [{ fieldKey: 'policy_number' }],
}));
vi.mock('@/lib/records/uploadLimitLoader', () => ({ refreshUploadLimit: async () => {} }));

const resolved = vi.fn(async (_db: unknown, _id: unknown, key: any) =>
  ALL.find((c) => c.moduleKey === key.moduleKey && c.documentKey === key.documentKey) ?? null);
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: (...a: any[]) => (resolved as any)(...a),
}));

const classifyDocument = vi.fn();
vi.mock('@/lib/ai', () => ({ classifyDocument: (...a: any[]) => classifyDocument(...a) }));

const runAutofill = vi.fn(async () => ({ fields: { policy_number: 'P-1' }, holderName: '', usageId: 'use-read' }));
vi.mock('@/lib/records/autofillRun', () => ({
  MAX_BYTES: 25 * 1024 * 1024,
  AI_STATUS: {},
  pagesForAi: async () => ({
    aiFiles: [{ base64: 'x', mimeType: 'image/jpeg', fileName: 'p1.jpg', pageNumber: 1 }],
    pagesTotal: 1,
  }),
  matchHolderByName: async () => 'member-1',
  runAutofill: (...a: any[]) => (runAutofill as any)(...a),
  pdfPasswordFrom: () => undefined,
  pdfPasswordResponse: () => null,
}));

const setAiUsageCategory = vi.fn(async () => {});
vi.mock('@/lib/aiUsageLink', () => ({
  linkAiUsageToExistingDocument: async () => {},
  setAiUsageCategory: (...a: any[]) => (setAiUsageCategory as any)(...a),
}));

const { POST } = await import('@/app/api/modules/[moduleKey]/[documentKey]/autofill/route');

const call = async (flags: Record<string, string> = {}) => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'scan.jpg', { type: 'image/jpeg' }));
  for (const [k, v] of Object.entries(flags)) form.append(k, v);
  const res = await POST(
    new Request('http://localhost/api/modules/insurance/health_insurance/autofill', { method: 'POST', body: form }),
    { params: Promise.resolve({ moduleKey: 'insurance', documentKey: 'health_insurance' }) },
  );
  return { status: res.status, body: await res.json() };
};

const classifiedAs = (c: { moduleKey: string; documentKey: string }, extra: object = {}) =>
  classifyDocument.mockResolvedValue({
    moduleKey: c.moduleKey, documentKey: c.documentKey, alternatives: [],
    title: 'PAN Card', holderName: 'Ramya Krishnan', usageId: 'use-classify', ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  permittedKeys.mockResolvedValue([
    { moduleKey: 'insurance', documentKey: 'health_insurance' },
    { moduleKey: 'identity', documentKey: 'pan_card' },
  ]);
  classifiedAs(PAN);
});

describe('POST /api/modules/:m/:d/autofill — category check', () => {
  it('does not classify at all without the flag', async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(classifyDocument).not.toHaveBeenCalled();
    expect(body.fields).toEqual({ policy_number: 'P-1' });
    expect(body.mismatch).toBeUndefined();
  });

  it('answers with a mismatch and spends no field read', async () => {
    const { status, body } = await call({ checkCategory: '1' });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mismatch.selected.documentKey).toBe('health_insurance');
    expect(body.mismatch.detected).toMatchObject({ moduleKey: 'identity', documentKey: 'pan_card', id: PAN.id });
    // "Other of that category" — the module the user PICKED, not the detected one.
    expect(body.mismatch.otherCategory).toMatchObject({ moduleKey: 'insurance', documentKey: 'other', id: INS_OTHER.id });
    expect(body.mismatch.detectedPermitted).toBe(true);
    expect(body.fields).toEqual({});
    expect(body.usageIds).toEqual(['use-classify']);
    expect(runAutofill).not.toHaveBeenCalled();
    expect(setAiUsageCategory).toHaveBeenCalledWith('t1', 'use-classify', 'identity', 'pan_card');
  });

  it('says so when the member may not file under the detected category', async () => {
    permittedKeys.mockResolvedValue([{ moduleKey: 'insurance', documentKey: 'health_insurance' }]);

    const { body } = await call({ checkCategory: '1' });

    expect(body.mismatch.detectedPermitted).toBe(false);
    expect(runAutofill).not.toHaveBeenCalled();
  });

  it('reads the fields when the classifier agrees', async () => {
    classifiedAs(HEALTH);

    const { body } = await call({ checkCategory: '1' });

    expect(body.mismatch).toBeUndefined();
    expect(body.fields).toEqual({ policy_number: 'P-1' });
    // Both the classify and the read are attributed to the record.
    expect(body.usageIds).toEqual(['use-classify', 'use-read']);
  });

  it('reads the fields when the pick is a runner-up', async () => {
    classifiedAs(PAN, { alternatives: [{ moduleKey: 'insurance', documentKey: 'health_insurance' }] });

    const { body } = await call({ checkCategory: '1' });

    expect(body.mismatch).toBeUndefined();
    expect(runAutofill).toHaveBeenCalledTimes(1);
  });

  it('reads the fields when the classifier could not place the document', async () => {
    classifiedAs({ moduleKey: 'other', documentKey: 'uncategorized' });

    const { body } = await call({ checkCategory: '1' });

    expect(body.mismatch).toBeUndefined();
    expect(runAutofill).toHaveBeenCalledTimes(1);
  });

  it('skips the classify on the re-read after the user has answered', async () => {
    const { body } = await call({ checkCategory: '1', skipCategoryCheck: '1' });

    expect(classifyDocument).not.toHaveBeenCalled();
    expect(body.mismatch).toBeUndefined();
    expect(runAutofill).toHaveBeenCalledTimes(1);
  });

  it('still reads the fields when the classifier answers with something unparseable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    classifyDocument.mockRejectedValue(new SyntaxError('Unexpected token'));

    const { status, body } = await call({ checkCategory: '1' });

    // The check is best effort: it must not take the read the user asked for down with it.
    expect(status).toBe(200);
    expect(body.mismatch).toBeUndefined();
    expect(body.fields).toEqual({ policy_number: 'P-1' });
  });

  it('lets any other classify failure surface, as the read would have failed too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    classifyDocument.mockRejectedValue(Object.assign(new Error('No credits'), { errorCode: 'NOPE' }));

    const { status, body } = await call({ checkCategory: '1' });

    expect(status).toBe(500);
    expect(body.error).toBe('No credits');
    expect(runAutofill).not.toHaveBeenCalled();
  });

  it('stays quiet rather than asking a question the form cannot answer', async () => {
    // The module has no Other row and the catch-all does not resolve either.
    resolved.mockImplementation(async (_d: unknown, _i: unknown, key: any) =>
      key.documentKey === 'other' || key.documentKey === 'uncategorized'
        ? null
        : ALL.find((c) => c.moduleKey === key.moduleKey && c.documentKey === key.documentKey) ?? null);

    const { body } = await call({ checkCategory: '1' });

    expect(body.mismatch).toBeUndefined();
    expect(runAutofill).toHaveBeenCalledTimes(1);
  });
});
