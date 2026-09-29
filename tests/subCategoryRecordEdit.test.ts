/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EDITING A SUB-CATEGORY RECORD — /api/modules/:m/:d/:id                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sub-category workspace can now change a record, not just add and delete
 * one, and three things about that are security contracts rather than UI:
 *
 *  · THE GATE IS `edit`, NARROWED TO THE ONE CATEGORY. A member who may view a
 *    PAN card must not be able to rewrite it, and a member denied `pan_card`
 *    must not reach one through the module they do hold.
 *  · THE URL NAMES THE CATEGORY AND THE ROW OWNS ITS OWNER. A body that claims
 *    a different category or a different owner must change neither — the
 *    ciphertext lives in the category's Drive folder with the pair bound into
 *    its AAD, and `createRecord` defaults `ownerId` to the CALLER.
 *  · READING PLAINTEXT IS AUDITED. The form has to be seeded with the sealed
 *    tier in the clear, so GET is a reveal and must leave a trail like the
 *    dedicated reveal route does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const hasPermission = vi.fn();
const getRecord = vi.fn();
const revealRecord = vi.fn();
const createRecord = vi.fn();
const writeAudit = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn(async (_t: string, cb: any) => cb({})) }));
// Only `writeAudit` is stubbed — the vocabulary and the sentence builder are
// pure, so the real ones run and this test sees the wording the app writes.
vi.mock('@/lib/audit', async () => ({
  writeAudit: (...a: any[]) => writeAudit(...a),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
// The real gate runs; only the data functions it hands the handler are stubbed.
vi.mock('@/lib/records/handler', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getRecord: (...a: any[]) => getRecord(...a),
  revealRecord: (...a: any[]) => revealRecord(...a),
  createRecord: (...a: any[]) => createRecord(...a),
}));
// The category's declared fields, from the seed rather than from Postgres.
vi.mock('@/lib/records/categorySpec', async () => {
  const { fieldsFor } = await import('@/lib/documentCategoryFields');
  return { loadCategoryFieldSpec: async (_db: any, key: any) => fieldsFor(key) };
});

const { GET, PUT } = await import('@/app/api/modules/[moduleKey]/[documentKey]/[id]/route');

const STANDARD = { id: 'u1', tenantId: 't1', role: 'STANDARD' };
const ID = '11111111-1111-1111-1111-111111111111';
const params = (documentKey = 'pan_card') => ({
  params: Promise.resolve({ moduleKey: 'identity', documentKey, id: ID }),
});

const EXISTING = {
  id: ID,
  title: 'Priya PAN',
  userId: 'owner-9',
  holderId: 'member-2',
  // `getRecord` projects the holder by name via a leftJoin (see handler.ts);
  // the audit line reads it from here.
  holder: { id: 'member-2', name: 'Priya Krishnan' },
  fields: { document_title: 'Priya PAN' },
  masked: { pan_number: '••••234F' },
};

/** A form submission, as the browser sends it. */
function form(entries: Record<string, string>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(entries)) body.append(k, v);
  return new Request(`http://localhost/api/modules/identity/pan_card/${ID}`, {
    method: 'PUT',
    body,
  });
}

const VALID = {
  title: 'Priya PAN',
  document_title: 'Priya PAN',
  pan_number: 'ABCDE1234F',
  holderId: 'member-2',
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequest.mockResolvedValue(STANDARD);
  hasPermission.mockResolvedValue(true);
  getRecord.mockResolvedValue(EXISTING);
  // `revealRecord` returns the plaintext ALONGSIDE the record's identity — the
  // audit row it forces the route to write has to name which record was opened.
  revealRecord.mockResolvedValue({
    sealed: { pan_number: 'ABCDE1234F' },
    title: 'Arjun PAN',
    categoryModuleKey: 'identity',
    categoryDocumentKey: 'pan_card',
    holderName: 'Arjun Krishnan',
  });
  createRecord.mockImplementation(async (_ctx: any, input: any) => ({ ...EXISTING, title: input.title }));
});

describe('PUT — the gate', () => {
  it('asks for `edit`, not `view`', async () => {
    await PUT(form(VALID), params());
    expect(hasPermission).toHaveBeenCalledWith(STANDARD, 'identity', 'edit', 'pan_card');
  });

  it('403s a member denied THIS sub-category, and writes nothing', async () => {
    hasPermission.mockImplementation(
      async (_u: any, _m: string, _a: string, documentKey?: string) => documentKey !== 'pan_card',
    );
    const res = await PUT(form(VALID), params());
    expect(res.status).toBe(403);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await PUT(form(VALID), params())).status).toBe(401);
  });

  it('404s a record that is not in this category — and does not write', async () => {
    // `getRecord` resolves through the narrowed key set, so another
    // sub-category's record is simply absent from here.
    getRecord.mockResolvedValue(null);
    const res = await PUT(form(VALID), params());
    expect(res.status).toBe(404);
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe('PUT — what the write is allowed to change', () => {
  it('updates in place: the record id is the replace target', async () => {
    await PUT(form(VALID), params());
    expect(createRecord.mock.calls[0][1]).toMatchObject({ replaceId: ID, taxonomyFields: true });
  });

  it('files the record under the URL’s category, whatever the body says', async () => {
    await PUT(form({ ...VALID, moduleKey: 'finance', documentKey: 'bank_passbook', categoryId: 'other' }),
      params());
    expect(createRecord.mock.calls[0][1].categoryKey)
      .toEqual({ moduleKey: 'identity', documentKey: 'pan_card' });
  });

  it('keeps the record’s original owner rather than the caller', async () => {
    // createRecord defaults ownerId to the caller, which would reassign every
    // record an admin edits.
    await PUT(form({ ...VALID, userId: 'u1' }), params());
    expect(createRecord.mock.calls[0][1].ownerId).toBe('owner-9');
  });

  it('drops a key the category does not declare', async () => {
    await PUT(form({ ...VALID, account_number: '123456789012' }), params());
    const { record } = createRecord.mock.calls[0][1];
    expect(record.pan_number).toBe('ABCDE1234F');
    expect(record.account_number).toBeUndefined();
  });

  it('400s a submission with no holder, before writing anything', async () => {
    const { holderId, ...noHolder } = VALID;
    const res = await PUT(form(noHolder), params());
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.holderId).toBeTruthy();
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('reports a duplicate as a confirmable 409, not a failure', async () => {
    const { RecordConflictError } = await import('@/lib/records/handler');
    createRecord.mockRejectedValue(new RecordConflictError('other-id', 'A documents record with this pan number already exists.'));
    const res = await PUT(form(VALID), params());
    expect(res.status).toBe(409);
    expect((await res.json()).requiresConfirmation).toBe(true);
  });

  it('audits the update', async () => {
    await PUT(form(VALID), params());
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'documents', entityId: ID, tenantId: 't1' }),
    );
  });
});

describe('GET — seeding the edit form', () => {
  const read = () => GET(new Request(`http://localhost/api/modules/identity/pan_card/${ID}`), params());

  it('returns the open tier AND the sealed tier in the clear', async () => {
    const body = await (await read()).json();
    expect(body.record.title).toBe('Priya PAN');
    // Without this the form would seed the number field from the MASK and save
    // '••••234F' back over a real PAN.
    expect(body.sealed.pan_number).toBe('ABCDE1234F');
  });

  it('is gated on `edit` — nothing else needs plaintext', async () => {
    await read();
    expect(hasPermission).toHaveBeenCalledWith(STANDARD, 'identity', 'edit', 'pan_card');
  });

  it('audits the reveal, naming the fields it handed over', async () => {
    await read();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      entityId: ID,
      details: expect.stringContaining('pan_number'),
    }));
  });

  it('404s — without revealing anything — when the record is not reachable', async () => {
    getRecord.mockResolvedValue(null);
    expect((await read()).status).toBe(404);
    expect(revealRecord).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
