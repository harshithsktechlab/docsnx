/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/documents/autofill — WHAT IT ANSWERS WHEN IT CANNOT HELP          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The route classifies an uploaded document and then reads it against that
 * category's field spec. The interesting half is what it does when the
 * classification is not usable:
 *
 *  · a category the member may not ADD to — it says so, and must NOT spend a
 *    second AI call reading fields they could never save;
 *  · a document it cannot place at all — the catch-all, which the upload form
 *    reads as "could not classify" rather than as a filing decision.
 *
 * Both come back as `success: true` WITH a category, because the sentence the
 * user reads has to name it. `resolveAutofillOutcome` (tests/autofillOutcome)
 * is what stops the form treating that as a selection; these assert the half of
 * the contract it depends on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PAN = {
  id: '11111111-1111-4111-8111-111111111111',
  moduleKey: 'identity',
  documentKey: 'pan_card',
  moduleName: 'Identity',
  documentName: 'PAN Card',
};

vi.mock('@/lib/db', () => ({ db: {}, withTenant: async (_t: string, cb: any) => cb({}) }));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'STANDARD' })),
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));

const permittedKeys = vi.fn(async () => [{ moduleKey: 'identity', documentKey: 'pan_card' }]);
/**
 * The household, which is what every case below is about.
 *
 * The routes under test now resolve a workspace first (`resolveUtilityCompany`),
 * and it reaches `hasCompanyAccess` and the DB. Mocked to "no company" rather
 * than left to the real gate: these suites assert what the PERSONAL page does,
 * and a company's behaviour has its own tests. `inCompanyOf` is the real rule —
 * `company_id IS NULL` here — so the predicates being asserted stay honest.
 */
vi.mock('@/lib/records/companyScope', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  resolveUtilityCompany: async () => ({ companyId: null }),
}));

vi.mock('@/lib/records/handler', () => ({
  documentManagerContext: async () => ({ keys: await permittedKeys() }),
}));

const resolved = vi.fn(async () => PAN as any);
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: (...a: any[]) => resolved(...(a as [])),
}));

const classifyDocument = vi.fn(async () => ({
  moduleKey: 'identity', documentKey: 'pan_card', title: 'PAN Card', holderName: 'Ramya Krishnan',
}));
vi.mock('@/lib/ai', () => ({ classifyDocument: (...a: any[]) => classifyDocument(...(a as [])) }));

const runAutofill = vi.fn(async () => ({
  fields: { pan_number: 'ABCDE1234F' }, holderName: '', fieldCount: 8,
}));
vi.mock('@/lib/records/autofillRun', () => ({
  MAX_BYTES: 25 * 1024 * 1024,
  AI_STATUS: {},
  pagesForAi: async () => ({
    aiFiles: [{ base64: 'x', mimeType: 'image/jpeg', fileName: 'p1.jpg', pageNumber: 1 }],
    pagesTotal: 1,
  }),
  matchHolderByName: async (name: string) => (name === 'Ramya Krishnan' ? 'member-1' : ''),
  runAutofill: (...a: any[]) => runAutofill(...(a as [])),
}));

const { POST } = await import('@/app/api/documents/autofill/route');

const call = async () => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'scan.jpg', { type: 'image/jpeg' }));
  const res = await POST(new Request('http://localhost/api/documents/autofill', {
    method: 'POST', body: form,
  }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  permittedKeys.mockResolvedValue([{ moduleKey: 'identity', documentKey: 'pan_card' }] as any);
  resolved.mockResolvedValue(PAN as any);
  classifyDocument.mockResolvedValue({
    moduleKey: 'identity', documentKey: 'pan_card', title: 'PAN Card', holderName: 'Ramya Krishnan',
  } as any);
  runAutofill.mockResolvedValue({ fields: { pan_number: 'ABCDE1234F' }, holderName: '', fieldCount: 8 } as any);
});

describe('POST /api/documents/autofill', () => {
  it('reads the fields when the member may file under the classified category', async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.category.id).toBe(PAN.id);
    expect(body.fields).toEqual({ pan_number: 'ABCDE1234F' });
    expect(body.notice).toBeUndefined();
    expect(body.holderId).toBe('member-1');
    expect(runAutofill).toHaveBeenCalledTimes(1);
  });

  it('names the category it cannot file under, and spends no second AI call', async () => {
    // The member holds a DIFFERENT sub-category of the same module — the check
    // is per (moduleKey, documentKey), not per module.
    permittedKeys.mockResolvedValue([{ moduleKey: 'identity', documentKey: 'passport' }] as any);

    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // Sent so the sentence can NAME it — not so the form can select it.
    expect(body.category.id).toBe(PAN.id);
    expect(body.notice).toContain('PAN Card');
    expect(body.fields).toEqual({});
    // The whole point: a category they could never save is not worth a read.
    expect(runAutofill).not.toHaveBeenCalled();
  });

  it('spends no second AI call on a document it could not place', async () => {
    // The catch-all is the model saying it does not know. Reading the document
    // against the catch-all's OWN spec was a billed call whose keys belong to
    // `other/uncategorized` — the form is about to render some other
    // category's inputs, and `applyAutofill` drops every key it has no input
    // for. So the answer could not be applied by construction, and the user
    // paid for it.
    const OTHER = {
      id: '22222222-2222-4222-8222-222222222222',
      moduleKey: 'other',
      documentKey: 'uncategorized',
      moduleName: 'Others',
      documentName: 'Others',
    };
    resolved.mockResolvedValue(OTHER as any);
    classifyDocument.mockResolvedValue({
      moduleKey: 'other', documentKey: 'uncategorized', title: 'Scanned page', holderName: 'Ramya Krishnan',
    } as any);

    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.unclassified).toBe(true);
    expect(body.fields).toEqual({});
    expect(runAutofill).not.toHaveBeenCalled();
    // Still worth having whatever the document turns out to be: the form fills
    // both in before asking the user which category it belongs to.
    expect(body.title).toBe('Scanned page');
    expect(body.holderId).toBe('member-1');
  });

  it('refuses rather than guessing when the taxonomy cannot resolve the pair', async () => {
    resolved.mockResolvedValue(null as any);

    const { status, body } = await call();

    expect(status).toBe(422);
    expect(body.success).toBeUndefined();
    expect(body.error).toMatch(/pick one/i);
    expect(runAutofill).not.toHaveBeenCalled();
  });

  it('refuses a member who may file nowhere at all', async () => {
    permittedKeys.mockResolvedValue([] as any);

    const { status } = await call();

    expect(status).toBe(403);
    expect(classifyDocument).not.toHaveBeenCalled();
  });
});
