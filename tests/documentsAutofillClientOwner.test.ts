/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/documents/autofill — A CLIENT'S DOCUMENT, READ ON ONE UPLOAD      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A company that keeps client documents uploads "Ram Das's PAN card" through the
 * Document Manager. The classifier only knows the company's own taxonomy, so it
 * used to file it as "PAN Card (Business)" with a holder nobody matched. With
 * client types ticked, the route now reads whose document it is, matches that to a
 * client, and answers with the CLIENT's category and an owner for the form to
 * confirm — and with nothing ticked, or for the company's own paper, it answers
 * exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blindIndex } from '@/lib/fieldCrypto';
import { DOCUMENT_CATEGORY_SEED } from '@/lib/documentCategories';
import { CLIENT_CATEGORY_SEED } from '@/lib/clientCategories';

vi.mock('@/lib/db', () => ({ db: {}, withTenant: async (_t: string, cb: any) => cb({}) }));
vi.mock('@/lib/taxonomyRegistry', () => ({
  taxonomyRows: async () => [...DOCUMENT_CATEGORY_SEED, ...CLIENT_CATEGORY_SEED].map((r) => ({ ...r, isSystem: true })),
}));

const hasPermission = vi.fn(async (..._a: any[]) => true);
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN' })),
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null, requireActivePlanFor: () => null }));
vi.mock('@/lib/records/companyScope', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  resolveUtilityCompany: async () => ({ companyId: 'co-1' }),
}));
vi.mock('@/lib/records/handler', () => ({
  documentManagerContext: async () => ({ keys: [{ moduleKey: 'biz_registration', documentKey: 'pan_card' }] }),
}));

const BIZ_PAN = { id: 'cat-biz-pan', moduleKey: 'biz_registration', documentKey: 'pan_card', moduleName: 'Business Registration', documentName: 'PAN Card (Business)' };
const CLIENT_PAN = { id: 'cat-client-pan', moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card', moduleName: 'Client Documents — Individual', documentName: 'PAN Card' };
const resolved = vi.fn(async (_db: any, _id: any, key: any) =>
  (key.moduleKey === 'biz_client_individual' ? CLIENT_PAN : BIZ_PAN) as any);
vi.mock('@/lib/documentCategoryResolver', () => ({ resolveCategory: (...a: any[]) => (resolved as any)(...a) }));

const classifyDocument = vi.fn();
vi.mock('@/lib/ai', () => ({ classifyDocument: (...a: any[]) => classifyDocument(...a) }));

const runAutofill = vi.fn(async (..._a: any[]) => ({ fields: { pan_number: 'ABCPD1234E' }, holderName: '', fieldCount: 8 }));
vi.mock('@/lib/records/autofillRun', () => ({
  MAX_BYTES: 25 * 1024 * 1024, AI_STATUS: {},
  pagesForAi: async () => ({ aiFiles: [{ base64: 'x', mimeType: 'image/png', fileName: 'p.png', pageNumber: 1 }], pagesTotal: 1 }),
  matchHolderByName: vi.fn(async () => 'member-1'),
  runAutofill: (...a: any[]) => runAutofill(...a),
  pdfPasswordFrom: () => undefined,
  pdfPasswordResponse: () => null,
}));

const ctxState: { value: any } = { value: null };
vi.mock('@/lib/clients/scanOwners', async (importActual) => ({
  ...(await importActual<any>()),
  loadScanOwnerContext: vi.fn(async () => ctxState.value),
  clientCategoryIds: vi.fn(async () => ({ 'biz_client_individual/identity-pan_card': 'cat-client-pan', 'biz_client_individual/uncategorized': 'cat-others' })),
}));
const scanOwners = await import('@/lib/clients/scanOwners');

const { POST } = await import('@/app/api/documents/autofill/route');

const CTX = () => ({
  companyId: 'co-1',
  own: { name: 'Redpluto Analytics', legalName: null, pan: null, gstin: null, cin: null, tan: null },
  clients: [{ id: 'client-ram', clientType: 'individual', displayName: 'Ram Das', panHash: null, gstinHash: null, cinHash: null }],
  enabled: { individual: new Set(['identity-pan_card']), company: new Set<string>() },
});

const call = async (extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'RamDas_PAN.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await POST(new Request('http://localhost/api/documents/autofill?companyId=co-1', { method: 'POST', body: form }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  ctxState.value = CTX();
  hasPermission.mockResolvedValue(true);
  classifyDocument.mockResolvedValue({
    moduleKey: 'identity', documentKey: 'pan_card', title: 'PAN Card', holderName: 'RAM DAS',
    ownerName: 'RAM DAS', ownerType: 'individual', ownerIds: {},
  });
});

describe('with client document types ticked', () => {
  it("matches the person to a client by NAME and files it under the client's category", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    // The category answered is the CLIENT's, resolved for the derived pair.
    expect(body.category).toMatchObject({ id: 'cat-client-pan', moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' });
    expect(body.clientOwner.proposal).toMatchObject({ kind: 'client', owner: 'individual', via: 'name', attention: false });
    expect(body.clientOwner.clientId).toBe('client-ram');
    expect(body.clientOwner.sourcePair).toEqual({ moduleKey: 'identity', documentKey: 'pan_card' });
    expect(body.clientOwner.categoryIds['biz_client_individual/identity-pan_card']).toBe('cat-client-pan');
    expect(body.clientOwner.clients).toHaveLength(1);
    // The form reads the fields against the client category (its source's spec).
    expect(runAutofill.mock.calls[0][0].categoryKey).toEqual({ moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' });
    expect(body.fields).toEqual({ pan_number: 'ABCPD1234E' });
  });

  it('does not match the person to a workspace MEMBER — the client is who it belongs to', async () => {
    const { body } = await call();
    expect(body.holderId).toBe('');
  });

  it('asks the classifier whose document it is, offering only the ticked personal types', async () => {
    await call();
    const owner = classifyDocument.mock.calls[0][6];
    expect(owner.taskText).toContain('"ownerName"');
    expect(owner.stanza).toContain('"pan_card": PAN Card');
    expect([...owner.individualSourceKeys]).toEqual(['identity/pan_card']);
  });

  it('answers an unrecognised person as unknown, needing a choice — never guessing a client', async () => {
    classifyDocument.mockResolvedValue({
      moduleKey: 'identity', documentKey: 'pan_card', title: 'PAN Card', holderName: 'Vikram Singh',
      ownerName: 'Vikram Singh', ownerType: 'individual', ownerIds: {},
    });
    const { body } = await call();
    expect(body.clientOwner.proposal).toMatchObject({ kind: 'unknown', attention: true });
    expect(body.clientOwner.clientId).toBeNull();
    expect(body.clientOwner.proposal.read.name).toBe('Vikram Singh');
  });

  it('checks the CLIENT module permission, not the Document Manager keys, for a client category', async () => {
    hasPermission.mockResolvedValue(false);
    const { body } = await call();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'biz_client_individual', 'add', 'identity-pan_card');
    expect(body.notice).toContain('do not have permission');
    expect(runAutofill).not.toHaveBeenCalled();
  });

  it("leaves the company's OWN document exactly as the ordinary flow answers it", async () => {
    classifyDocument.mockResolvedValue({
      moduleKey: 'biz_registration', documentKey: 'pan_card', title: 'PAN Card', holderName: '',
      ownerName: 'Redpluto Analytics Pvt Ltd', ownerType: 'company', ownerIds: {},
    });
    const { body } = await call();
    expect(body.category.id).toBe('cat-biz-pan');
    expect(body.clientOwner.proposal.owner).toBe('own');
    expect(runAutofill.mock.calls[0][0].categoryKey.moduleKey).toBe('biz_registration');
  });

  it('skips all of it when the form says so ("Own company" on the client panel)', async () => {
    await call({ skipOwner: '1' });
    expect(scanOwners.loadScanOwnerContext).not.toHaveBeenCalled();
    expect(classifyDocument.mock.calls[0][6]).toBeNull();
  });
});

describe('with nothing ticked — the ordinary upload, untouched', () => {
  it('adds no owner to the prompt and no clientOwner to the answer', async () => {
    ctxState.value = null;
    classifyDocument.mockResolvedValue({ moduleKey: 'biz_registration', documentKey: 'pan_card', title: 'PAN Card', holderName: 'RAM DAS' });
    const { body } = await call();
    expect(classifyDocument.mock.calls[0][6]).toBeNull();
    expect(body.clientOwner).toBeUndefined();
    expect(body.category.id).toBe('cat-biz-pan');
    expect(body.holderId).toBe('member-1');
  });
});
