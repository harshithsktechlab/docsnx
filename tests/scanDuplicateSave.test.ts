/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POWER SCAN ASKS TOO                                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/ai/scan/save` used to pass `overwrite: true` for every record, on the
 * reasoning that the review grid was the confirmation step. It is not: the grid
 * shows what the OCR read, not what the tenant already holds. So re-scanning a
 * stack of paperwork rewrote whatever was already on file and reported every
 * one of them as "created".
 *
 * That made Power Scan the one write path in the app that could destroy an
 * existing record without anyone agreeing to it — and, since re-scanning the
 * same stack is the single most likely way to produce duplicates, the last
 * place that should have assumed consent.
 *
 * A duplicate is now reported as a QUESTION: the record is not saved, the
 * result carries `requiresConfirmation` and the record it matched, and the
 * review screen re-submits it with `replaceId` only if the user says update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRecord = vi.fn();
const writeAudit = vi.fn();

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

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/db/schema', () => ({ todos: {}, emergencyContacts: {} }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN',
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
  createRecord: (...a: any[]) => createRecord(...a),
  recordContextFor: vi.fn(async () => ({ user: { id: 'u1', tenantId: 't1' }, keys: [] })),
  canAnyInScope: vi.fn(async () => true),
  RecordConflictError,
  // Real: the shape a held-back record reports is the same 409 body every
  // other write path answers with, and the review screen reads one shape.
  conflictResponsePayload: (await importOriginal<any>()).conflictResponsePayload,
}));
// `scopeForCategory` is how the route decides where a record goes now: the
// resolved CATEGORY names the scope, not the `category` the client sent. The
// stub answers for the passport the resolver below returns.
vi.mock('@/lib/records/registry', () => ({
  isRecordScope: () => true,
  scopeForCategory: () => 'documents',
}));
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: vi.fn(async () => ({
    id: 'cat-1', moduleKey: 'identity', documentKey: 'passport', documentName: 'Passport',
  })),
}));
vi.mock('@/lib/vault/vaultMode', () => ({ usesVault: () => true }));
vi.mock('@/lib/profileUpdater', () => ({ autoUpdateProfile: vi.fn(async () => {}) }));
// Only `writeAudit` is stubbed — it is the half that touches the database.
// The vocabulary and the sentence builder are pure, so the real ones run and
// this test sees the wording the app actually writes.
vi.mock('@/lib/audit', async () => ({
  writeAudit: (...a: any[]) => writeAudit(...a),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/vault/vaultErrors', () => ({ vaultErrorResponse: () => null }));

const { POST } = await import('@/app/api/ai/scan/save/route');

const EXISTING = 'aaaaaaaa-1111-2222-3333-444444444444';

/** One reviewed record, as the bulk-scan screen submits it. */
function save(records: any[]) {
  return POST(new Request('http://localhost/api/ai/scan/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records, files: [] }),
  }));
}

const scanned = (over: Record<string, unknown> = {}) => ({
  category: 'document',
  title: 'Passport',
  fileIndices: [],
  extractedData: { categoryId: 'cat-1' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  createRecord.mockResolvedValue({ id: 'doc-1', title: 'Passport' });
});

describe('a scan that duplicates nothing', () => {
  it('is saved', async () => {
    const json = await (await save([scanned()])).json();

    expect(json.results[0]).toMatchObject({ success: true, id: 'doc-1' });
  });

  it('never tells createRecord to overwrite on its own', async () => {
    // THE regression. `overwrite: true` let `createRecord` resolve a match
    // itself and write straight onto it — no prompt, and the result still said
    // "created". Consent now travels only as an explicit `replaceId`.
    await save([scanned()]);

    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ overwrite: false }),
    );
  });
});

describe('a scan that duplicates something on file', () => {
  beforeEach(() => {
    createRecord.mockRejectedValue(
      new RecordConflictError(EXISTING, "'Ravi's Passport' already has this passport number.", "Ravi's Passport"),
    );
  });

  it('is held back rather than applied', async () => {
    const json = await (await save([scanned()])).json();

    expect(json.results[0].success).toBe(false);
    expect(json.results[0].requiresConfirmation).toBe(true);
  });

  it('names the record it matched, so the user can decide', async () => {
    const json = await (await save([scanned()])).json();

    expect(json.results[0].existingId).toBe(EXISTING);
    expect(json.results[0].existingTitle).toBe("Ravi's Passport");
    expect(json.results[0].error).toContain('passport number');
  });

  it('writes no audit row for a record it did not save', async () => {
    await save([scanned()]);

    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('does not stop the rest of the batch', async () => {
    // Per-record failure model: a scan of forty pages must not lose
    // thirty-nine because one of them was already on file.
    createRecord
      .mockRejectedValueOnce(new RecordConflictError(EXISTING, 'already exists', 'Ravi'))
      .mockResolvedValueOnce({ id: 'doc-2', title: 'Licence' });

    const json = await (await save([scanned(), scanned({ title: 'Licence' })])).json();

    expect(json.results).toHaveLength(2);
    expect(json.results[0].requiresConfirmation).toBe(true);
    expect(json.results[1].success).toBe(true);
  });
});

describe('the answer', () => {
  it('carries the chosen record through as replaceId', async () => {
    // The review screen re-submits only what the user picked, each naming the
    // record to write onto. `createRecord` excludes that record from its own
    // duplicate check, so this lands as a plain replace.
    await save([scanned({ replaceId: EXISTING })]);

    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replaceId: EXISTING }),
      expect.objectContaining({ overwrite: false }),
    );
  });

  it('reports an overwrite as an update, not a create', async () => {
    createRecord.mockResolvedValue({ id: EXISTING, title: 'Passport', replacedExisting: true });

    const json = await (await save([scanned()])).json();

    expect(json.results[0]).toMatchObject({ success: true, replaced: true });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.stringContaining('update') }),
    );
  });
});

describe('matching a result back to its record', () => {
  it('echoes the index each result came from', async () => {
    // A re-submit carries a SUBSET, so its results do not line up with the
    // first run's array. Without the index the screen would merge an answer
    // onto the wrong row.
    createRecord
      .mockResolvedValueOnce({ id: 'doc-1', title: 'A' })
      .mockResolvedValueOnce({ id: 'doc-2', title: 'B' });

    const json = await (await save([scanned({ title: 'A' }), scanned({ title: 'B' })])).json();

    expect(json.results.map((r: any) => r.index)).toEqual([0, 1]);
  });
});

describe('keeping both', () => {
  it('carries the answer through as keepBoth, with no record to write onto', async () => {
    // The other answer the review screen can send: the scan is a DIFFERENT
    // document that happens to share a name, so it is filed beside the one on
    // file rather than over it. Never both flags — `createRecord` refuses a
    // keep-both answer that arrives with a `replaceId`.
    await save([scanned({ keepBoth: true })]);

    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replaceId: null }),
      expect.objectContaining({ overwrite: false, keepBoth: true }),
    );
  });

  it('records it as a create that kept the other copy', async () => {
    // Not a replace: nothing was overwritten. The trail has to say the tenant
    // now holds two documents where the scan matched one.
    await save([scanned({ keepBoth: true })]);

    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.stringContaining('create'),
      details: expect.stringContaining('kept as a separate copy'),
    }));
  });

  it('is off unless the screen asked for it', async () => {
    await save([scanned()]);

    expect(createRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ keepBoth: false }),
    );
  });

  it('tells the screen whether the match can be forked at all', async () => {
    // An identifier clash cannot: two records claiming one passport number are
    // indistinguishable afterwards. The review row hides the answer rather than
    // offering one the server would refuse.
    const conflict: any = new RecordConflictError(
      EXISTING, "'Ravi's Passport' already has this passport number.", "Ravi's Passport",
    );
    conflict.match = {
      id: EXISTING, reason: 'dedupeField', detail: 'this passport number',
      title: "Ravi's Passport", moduleKey: 'identity', documentKey: 'passport',
      file: {
        filePath: '/api/records/documents/aaaa/file', fileName: 'passport.pdf',
        mimeType: 'application/pdf', fileSize: 1024, pageCount: 1, updatedAt: null,
      },
      keepBothTitle: null,
    };
    createRecord.mockRejectedValue(conflict);

    const json = await (await save([scanned()])).json();

    expect(json.results[0].keepBothAllowed).toBe(false);
    // …and the record it matched is still previewable, which is what makes the
    // remaining two answers answerable.
    expect(json.results[0].existingFile).toMatchObject({ mimeType: 'application/pdf' });
  });
});
