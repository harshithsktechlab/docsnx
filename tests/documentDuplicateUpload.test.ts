// @vitest-environment node
//
// Node's own FormData/File: jsdom drops a File's NAME through a Request, and
// the filename is half of what the duplicate check matches on.
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DOCUMENT MANAGER CANNOT BE MADE TO HOLD THE SAME DOCUMENT TWICE   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/documents` used to trust the page to notice duplicates. The page scans
 * `documents` — the rows it currently has loaded — so the check missed a match
 * on any other page of the list, missed every multi-file upload, and could not
 * run at all for the offline queue in sw.js or for anything that was not the
 * browser. The route itself passed `force: true` and compared nothing.
 *
 * So the check moved here, where nothing gets past it, and it runs for EVERY
 * file BEFORE the first one is written: a conflict raised half way through a
 * batch would leave the user answering a prompt about a state that had already
 * changed underneath them.
 *
 * Two lookups, deliberately answered differently:
 *
 *   · an ACTIVE twin is a visible record — the user is asked;
 *   · a DELETED twin is a tombstone they cannot see — there is nothing to ask
 *     about, so it is silently revived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRecord = vi.fn();
const resolveDuplicateForWrite = vi.fn();
const findDeletedTwin = vi.fn();

/**
 * The route branches on `instanceof`, so the tests and the module under test
 * have to be looking at the SAME class — a lookalike thrown from here would
 * fall through to the generic 500 handler and the test would pass for the
 * wrong reason.
 */
class RecordConflictError extends Error {
  constructor(
    public existingId: string,
    message: string,
    public existingTitle?: string,
  ) {
    super(message);
    this.name = 'RecordConflictError';
  }
}

vi.mock('@/lib/db', () => {
  const chain = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
    query: {
      users: { findFirst: async () => ({ id: 'u1', tenantId: 't1' }) },
      // Every id the request offers to overwrite is looked up and must belong
      // to this tenant. These tests always name real ones.
      documents: { findFirst: async () => ({ id: 'existing', tenantId: 't1', filePath: null }) },
    },
  };
  return { db: chain, withTenant: async (_t: string, cb: any) => cb(chain) };
});
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1',
    tenantId: 't1',
    role: 'TENANT_ADMIN',
    tenant: { id: 't1', googleDriveEnabled: true, googleDriveTokens: '{}' },
  })),
  hasPermission: vi.fn(async () => true),
}));
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

vi.mock('@/lib/records/handler', async (importOriginal) => ({
  documentManagerContext: vi.fn(async () => ({
    user: { id: 'u1', tenantId: 't1' }, keys: ['identity/passport'],
  })),
  createRecord: (...a: any[]) => createRecord(...a),
  // The SAME call `createRecord` makes. The route used to run only the title
  // and filename arms itself and leave the identifier arm to `createRecord` —
  // which is exactly how a matching document number got applied silently.
  resolveDuplicateForWrite: (...a: any[]) => resolveDuplicateForWrite(...a),
  RecordConflictError,
  categoryIdIn: vi.fn(() => undefined),
  permittedCategories: vi.fn(async () => []),
  holderErrorResponse: vi.fn(() => null),
  // NOT stubbed. The 409 body is the contract this file is about, and a
  // hand-written stand-in for it would assert the shape the test invented
  // rather than the one four routes actually answer with.
  duplicateConflictPayload: (await importOriginal<any>()).duplicateConflictPayload,
  conflictResponsePayload: (await importOriginal<any>()).conflictResponsePayload,
}));
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: vi.fn(async () => ({
    id: 'cat-1', documentName: 'Passport',
    moduleKey: 'identity', documentKey: 'passport',
  })),
  isUuid: () => true,
}));
vi.mock('@/lib/records/documentVisibility', () => ({
  findDeletedTwin: (...a: any[]) => findDeletedTwin(...a),
  visibleDocument: vi.fn(() => undefined),
}));
vi.mock('@/lib/records/documentPurge', () => ({
  invalidateAnalysisCache: vi.fn(async () => {}),
}));
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/profileUpdater', () => ({ autoUpdateProfile: vi.fn(async () => {}) }));

const { POST } = await import('@/app/api/documents/route');

const CATEGORY = '11111111-1111-1111-1111-111111111111';
const EXISTING = 'aaaaaaaa-1111-2222-3333-444444444444';

/** The form's own upload, plus whatever answer the caller is giving. */
function upload(files: Array<[string, string]>, extra: Record<string, string> = {}) {
  const body = new FormData();
  for (const [name, type] of files) {
    body.append('files', new File([new Uint8Array([1, 2, 3])], name, { type }));
  }
  body.append('title', 'Passport');
  body.append('categoryId', CATEGORY);
  for (const [k, v] of Object.entries(extra)) body.append(k, v);
  return POST(new Request('http://localhost/api/documents', { method: 'POST', body }));
}

/** A match as `resolveDuplicateForWrite` reports one. */
const match = (over: Record<string, unknown> = {}) => ({
  id: EXISTING,
  reason: 'title',
  detail: 'this title, in this category',
  title: 'Passport',
  moduleKey: 'identity',
  documentKey: 'passport',
  // What the prompt previews, and the name a keep-both answer would file the
  // copy under — both resolved by `resolveDuplicate` alongside the match.
  file: {
    filePath: '/api/records/documents/aaaa/file',
    fileName: 'passport.pdf',
    mimeType: 'application/pdf',
    fileSize: 2048,
    pageCount: 1,
    updatedAt: new Date('2026-02-01T00:00:00Z'),
  },
  keepBothTitle: 'Passport (2)',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveDuplicateForWrite.mockResolvedValue(null);
  findDeletedTwin.mockResolvedValue(null);
  createRecord.mockResolvedValue({ id: 'doc-1', title: 'Passport', fields: {}, masked: {} });
});

describe('an upload that duplicates a visible document', () => {
  beforeEach(() => {
    resolveDuplicateForWrite.mockResolvedValue(match());
  });

  it('is refused with the id of the document it duplicates', async () => {
    const res = await upload([['passport.pdf', 'application/pdf']]);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.requiresConfirmation).toBe(true);
    // The same two fields every other module's 409 carries, so a client that
    // handles one duplicate needs no special case for this route.
    expect(json.existingId).toBe(EXISTING);
    expect(json.existingTitle).toBe('Passport');
    // Where it lives, so the prompt can offer to open it.
    expect(json.existingModuleKey).toBe('identity');
    expect(json.existingDocumentKey).toBe('passport');
  });

  it('writes nothing while it waits for the answer', async () => {
    await upload([['passport.pdf', 'application/pdf']]);

    expect(createRecord).not.toHaveBeenCalled();
  });

  it('overwrites that document once the answer comes back', async () => {
    // `replaceId` is the page's answer. It names the record to write onto, so
    // `createRecord` reuses the row and its Drive object rather than adding a
    // second one — the whole point of asking.
    const res = await upload([['passport.pdf', 'application/pdf']], { replaceId: EXISTING });

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replaceId: EXISTING }),
      // `overwrite: false`. The confirmation is carried by `replaceId`, which
      // names the record; `overwrite: true` was what let a match createRecord
      // found ON ITS OWN be applied without anyone being asked.
      expect.objectContaining({ overwrite: false }),
    );
  });

  it('does not go looking once the caller has already chosen', async () => {
    await upload([['passport.pdf', 'application/pdf']], { replaceId: EXISTING });

    // An explicit choice outranks a guess: re-resolving could pick a different
    // record than the one the user was shown and agreed to.
    expect(resolveDuplicateForWrite).not.toHaveBeenCalled();
  });
});

describe('a batch', () => {
  it('is checked in full before any of it is written', async () => {
    // The second file collides. Refusing mid-loop would leave the first one
    // written and the user answering about a list that had already changed.
    resolveDuplicateForWrite
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(match({ title: 'Licence', reason: 'fileName' }));

    const res = await upload([
      ['passport.pdf', 'application/pdf'],
      ['licence.pdf', 'application/pdf'],
    ]);

    expect(res.status).toBe(409);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('reports every collision, not just the first', async () => {
    resolveDuplicateForWrite.mockResolvedValue(match());

    const json = await (await upload([
      ['passport.pdf', 'application/pdf'],
      ['licence.pdf', 'application/pdf'],
    ])).json();

    // `replaceId` names one record and so can only answer for one file. A
    // batch needs a target per file, which is what `duplicates` feeds.
    expect(json.duplicates).toHaveLength(2);
    expect(json.duplicates[0]).toMatchObject({ fileName: 'passport.pdf', existingId: EXISTING });
  });
});

describe('a conflict the pre-flight could not have seen', () => {
  // One `metadata` is shared across every file in a request, so a batch
  // carrying a document number collides with ITSELF: the pre-flight ran against
  // a database that did not contain file 1 yet, and file 2 then matches it.
  // A concurrent request filing a match between the check and the insert lands
  // here the same way, and no amount of pre-flighting closes that.
  const conflict = () => new RecordConflictError(
    EXISTING, "'Passport' already has this document number.", 'Passport',
  );

  it('keeps what was written and names what was not', async () => {
    // THE regression. Letting the conflict reach the outer catch turned the
    // whole request into a 409 while file 1 stayed written — the caller was
    // told the upload was refused and quietly ended up with half of it.
    //
    // Queued per test rather than in a `beforeEach`: `vi.clearAllMocks()`
    // clears calls, NOT queued implementations, so an unconsumed `Once` set up
    // for one test fires inside the next one.
    createRecord
      .mockResolvedValueOnce({ id: 'doc-1', title: 'Passport', fields: {}, masked: {} })
      .mockRejectedValueOnce(conflict());

    const res = await upload([
      ['passport.pdf', 'application/pdf'],
      ['licence.pdf', 'application/pdf'],
    ]);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.documents).toHaveLength(1);
    expect(json.duplicates).toHaveLength(1);
    expect(json.duplicates[0]).toMatchObject({
      fileName: 'licence.pdf', existingId: EXISTING,
    });
    // The caller is told there is still a question outstanding, using the same
    // flag every other refusal carries.
    expect(json.requiresConfirmation).toBe(true);
  });

  it('still refuses outright when NOTHING was written', async () => {
    createRecord.mockRejectedValueOnce(conflict());

    const res = await upload([['passport.pdf', 'application/pdf']]);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.requiresConfirmation).toBe(true);
    expect(json.existingId).toBe(EXISTING);
  });

  it('takes a target per file as the answer', async () => {
    resolveDuplicateForWrite.mockResolvedValue(match());

    const res = await upload(
      [['passport.pdf', 'application/pdf'], ['licence.pdf', 'application/pdf']],
      { replaceIds: JSON.stringify({ 'passport.pdf': EXISTING, 'licence.pdf': 'bbbb-2' }) },
    );

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(createRecord.mock.calls[1][1]).toMatchObject({ replaceId: 'bbbb-2' });
  });

  it('refuses an unparseable answer rather than ignoring it', async () => {
    // Silently dropping it would turn a confirmed overwrite back into a create
    // — the exact second copy the whole rule exists to prevent.
    const res = await upload([['passport.pdf', 'application/pdf']], { replaceIds: '{oops' });

    expect(res.status).toBe(400);
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe('an upload that duplicates something deleted', () => {
  it('revives the tombstone without asking', async () => {
    // The user cannot see a deleted row, so "this duplicates a document you
    // deleted" would be a question about something the UI never showed them.
    findDeletedTwin.mockResolvedValue({
      id: EXISTING, title: 'Passport', fileName: 'passport.pdf', reason: 'title',
    });

    const res = await upload([['passport.pdf', 'application/pdf']]);

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replaceId: EXISTING }),
      expect.anything(),
    );
  });

  it('is only consulted when nothing visible matched', async () => {
    resolveDuplicateForWrite.mockResolvedValue(match());

    await upload([['passport.pdf', 'application/pdf']]);

    // A visible duplicate is the user's decision to make; reviving a tombstone
    // instead would answer it for them, and answer it differently.
    expect(findDeletedTwin).not.toHaveBeenCalled();
  });
});

describe('THE BUG: a duplicate identifier, under a different name', () => {
  // The reported symptom, exactly: "I am able to add a duplicate though it
  // updating with the latest information, but no prompting message and how
  // user has to continue."
  //
  // Upload a document whose NUMBER matches one already filed, but whose title
  // and filename do not. The route's pre-flight ran only the title and
  // filename arms, found nothing, and handed the write to `createRecord` with
  // `overwrite: true` — which found the identifier match itself and wrote
  // straight onto the existing record. The user was never asked, and never
  // told it had happened.
  beforeEach(() => {
    resolveDuplicateForWrite.mockResolvedValue(match({
      reason: 'dedupeField',
      detail: 'this document number',
      title: "Ravi's Passport",
    }));
  });

  it('prompts instead of overwriting in silence', async () => {
    const res = await upload([['a-totally-different-name.pdf', 'application/pdf']]);

    expect(res.status).toBe(409);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('says which record it matched and why', async () => {
    const json = await (await upload([['a-totally-different-name.pdf', 'application/pdf']])).json();

    // Not "a document with this title already exists" — the titles differ, and
    // being told otherwise while looking at two different titles is worse than
    // no message at all.
    expect(json.error).toContain('document number');
    expect(json.error).toContain("Ravi's Passport");
    expect(json.requiresConfirmation).toBe(true);
  });

  it('lets the user open the record before agreeing to overwrite it', async () => {
    const json = await (await upload([['a-totally-different-name.pdf', 'application/pdf']])).json();

    // A document number names nothing a person recognises. The prompt has to
    // be able to link to the record being replaced.
    expect(json.existingTitle).toBe("Ravi's Passport");
    expect(json.existingModuleKey).toBe('identity');
    expect(json.existingDocumentKey).toBe('passport');
  });

  it('overwrites exactly that record once confirmed', async () => {
    const res = await upload(
      [['a-totally-different-name.pdf', 'application/pdf']],
      { replaceId: EXISTING },
    );

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(createRecord.mock.calls[0][1]).toMatchObject({ replaceId: EXISTING });
  });
});

describe('an ordinary upload', () => {
  it('is created, untouched by any of this', async () => {
    const res = await upload([['passport.pdf', 'application/pdf']]);

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replaceId: null }),
      expect.anything(),
    );
  });
});

describe('what the refusal hands the prompt', () => {
  beforeEach(() => {
    resolveDuplicateForWrite.mockResolvedValue(match());
  });

  it('carries the matched record’s file, so it can be SHOWN', async () => {
    // "Update it" asks the user to agree to overwriting a document they cannot
    // see. The 409 now carries a servable path and a mime type, and the prompt
    // renders it beside the file being uploaded.
    const json = await (await upload([['passport.pdf', 'application/pdf']])).json();

    expect(json.existingFile).toMatchObject({
      filePath: '/api/records/documents/aaaa/file',
      mimeType: 'application/pdf',
      fileName: 'passport.pdf',
    });
  });

  it('says which arm fired, and offers keeping both', async () => {
    const json = await (await upload([['passport.pdf', 'application/pdf']])).json();

    expect(json.reason).toBe('title');
    expect(json.keepBothAllowed).toBe(true);
    // Named before the user agrees, not reported after the fact.
    expect(json.keepBothTitle).toBe('Passport (2)');
  });

  it('withholds keeping both when the match is on an identifier', async () => {
    // Two records claiming one document number cannot be told apart afterwards,
    // so the answer is not offered — and `createRecord` refuses it regardless.
    resolveDuplicateForWrite.mockResolvedValue(
      match({ reason: 'dedupeField', detail: 'this document number' }),
    );

    const json = await (await upload([['passport.pdf', 'application/pdf']])).json();

    expect(json.keepBothAllowed).toBe(false);
    expect(json.keepBothTitle).toBeNull();
  });

  it('withholds the file from a member who may not VIEW that category', async () => {
    // A match is always a record the caller may write to, but `add` on a
    // category does not imply `view` of it. Handing back a servable URL would
    // let such a member read documents by uploading collisions until one hit.
    const { hasPermission } = await import('@/lib/auth');
    (hasPermission as any).mockImplementation(
      async (_u: any, _m: string, action: string) => action !== 'view',
    );

    const json = await (await upload([['passport.pdf', 'application/pdf']])).json();

    expect(json.existingFile).toBeNull();
    // The refusal itself still names the record — that much the caller already
    // learns from being refused.
    expect(json.existingId).toBe(EXISTING);
  });
});

describe('an upload the user chose to keep alongside', () => {
  beforeEach(() => {
    resolveDuplicateForWrite.mockResolvedValue(match());
  });

  it('is written as a new record rather than refused', async () => {
    const res = await upload([['passport.pdf', 'application/pdf']], { keepBoth: 'true' });

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      // No `replaceId`: nothing is being written onto.
      expect.objectContaining({ replaceId: null }),
      expect.objectContaining({ overwrite: false, keepBoth: true }),
    );
  });

  it('does not revive a tombstone instead', async () => {
    // The deleted twin carries the title this upload is about to be filed under
    // a numbered variant of. Writing onto it would give the user the second
    // copy they asked for, minus the first.
    findDeletedTwin.mockResolvedValue({ id: 'dead-1', title: 'Passport' });

    await upload([['passport.pdf', 'application/pdf']], { keepBoth: 'true' });

    expect(findDeletedTwin).not.toHaveBeenCalled();
    expect(createRecord.mock.calls[0][1]).toMatchObject({ replaceId: null });
  });

  it('is keyed by source filename, so a batch is answered file by file', async () => {
    // `replaceId` names one record and so can only answer one file; keep-both
    // is per file for the same reason.
    //
    // A batch is still all-or-nothing: an answer covering only some of the
    // collisions leaves the rest unanswered, and the whole request is refused
    // before anything is written rather than landing half of it. So this
    // asserts the file that WAS answered is no longer reported, and the one
    // that was not still is.
    const json = await (await upload(
      [['passport.pdf', 'application/pdf'], ['licence.pdf', 'application/pdf']],
      { keepBoth: JSON.stringify(['passport.pdf']) },
    )).json();

    expect(createRecord).not.toHaveBeenCalled();
    expect(json.duplicates).toHaveLength(1);
    expect(json.duplicates[0].fileName).toBe('licence.pdf');
  });

  it('writes the whole batch once every collision has an answer', async () => {
    const res = await upload(
      [['passport.pdf', 'application/pdf'], ['licence.pdf', 'application/pdf']],
      { keepBoth: JSON.stringify(['passport.pdf', 'licence.pdf']) },
    );

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(createRecord.mock.calls[1][2]).toMatchObject({ keepBoth: true });
  });

  it('refuses an unparseable answer rather than ignoring it', async () => {
    // Dropping it silently would turn a deliberate fork back into a refusal —
    // or, worse under a different flag, into an overwrite.
    const res = await upload([['passport.pdf', 'application/pdf']], { keepBoth: '[oops' });

    expect(res.status).toBe(400);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('needs only `add`, the permission the form already required', async () => {
    const { permittedCategories } = await import('@/lib/records/handler');

    await upload([['passport.pdf', 'application/pdf']], { keepBoth: 'true' });

    // The context is built for the write; forking touches nothing that exists,
    // so demanding `edit` would refuse it to an add-only member.
    const { documentManagerContext } = await import('@/lib/records/handler');
    // The third argument is the workspace: `null` is the household, which is
    // what this suite is about. Asserted rather than ignored — it is what
    // narrows the writable categories to one taxonomy, so a route that stopped
    // passing it would silently offer business categories to a household upload.
    expect(documentManagerContext).toHaveBeenCalledWith(expect.anything(), 'add', null);
    expect(permittedCategories).not.toHaveBeenCalled();
  });
});
