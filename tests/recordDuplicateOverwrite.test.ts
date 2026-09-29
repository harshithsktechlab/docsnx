/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A DOCUMENT NEVER EXISTS TWICE BY ACCIDENT — the rule, where it holds   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every write in the app lands in `createRecord`, so this is where "an upload
 * that duplicates an existing record overwrites it, and never forks a second
 * copy unless somebody looked at both and asked for one" is either true or not
 * true. These are the regression guards for it.
 *
 * ── WHAT USED TO HAPPEN ────────────────────────────────────────────────────
 * The duplicate check was SKIPPED whenever the caller passed `force`. `force`
 * was what every "Save it anyway" button sent, so confirming a duplicate is
 * precisely what created the second copy — the prompt asked the user about a
 * problem and then caused it. `force` is now `overwrite` and means the
 * opposite: resolve the match and write onto it.
 *
 * The five things that must stay true:
 *
 *   1. Unconfirmed, a duplicate is REFUSED, carrying the id it clashed with so
 *      the caller can offer the choice.
 *   2. Confirmed, the write lands on THAT id — no new row, no new Drive object.
 *   3. Confirming does not smuggle an edit past a caller who may only add.
 *   4. A record is never its own duplicate, or no edit could ever be saved.
 *   5. "Keep both" — the third answer — forks a NEW record under a numbered
 *      title, leaves the match alone, and is refused for an identifier clash
 *      and for an edit however it arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hasPermission = vi.fn();
const resolveDuplicate = vi.fn();
const nextAvailableTitle = vi.fn();
const storeRecordInVault = vi.fn();
const uploadRecords = vi.fn();
const insertedRows: any[] = [];
const conflictUpdates: any[] = [];

/** One row for `getRecord` to find after the write. */
const READ_BACK = {
  id: 'PLACEHOLDER',
  userId: 'u1',
  holderId: null,
  holderName: null,
  isGlobal: false,
  title: 'Passport',
  categoryId: 'cat-1',
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'passport',
  categoryName: 'Passport',
  filePath: null,
  fileDriveId: null,
  fileName: null,
  mimeType: null,
  fileSize: 0,
  pageCount: 0,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * A Drizzle stand-in that answers every shape `createRecord` builds.
 *
 * `.limit()` resolves the category lookup and the read-back; `.insert()`
 * records what was written, which is where assertions 1–3 are actually made.
 */
function makeTx() {
  const chain: any = {
    select: (cols: any) => { chain._cols = cols; return chain; },
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      // The read-back asks for `title`; the category lookup asks only for `id`.
      if (chain._cols && 'title' in chain._cols) {
        return [{ ...READ_BACK, id: insertedRows.at(-1)?.id ?? 'unknown' }];
      }
      return [{ id: 'cat-1' }];
    },
    insert: () => chain,
    values: (row: any) => { insertedRows.push(row); return chain; },
    onConflictDoUpdate: async (spec: any) => { conflictUpdates.push(spec); return []; },
  };
  return chain;
}

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb(makeTx())),
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(),
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
vi.mock('@/lib/records/duplicateMatch', () => ({
  resolveDuplicate: (...a: any[]) => resolveDuplicate(...a),
  duplicateMessage: (m: any) => `'${m.title}' already has ${m.detail}.`,
  // The real rule, restated rather than stubbed: which matches may be forked is
  // the whole point of half these assertions.
  keepBothAllowed: (m: any) => m.reason !== 'dedupeField',
}));
// Only the numbering is stubbed — the rest of this module (the deleted/revived
// column sets, `visibleDocument`) is real, and `createRecord` writes with it.
vi.mock('@/lib/records/documentVisibility', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  nextAvailableTitle: (...a: any[]) => nextAvailableTitle(...a),
}));
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: vi.fn(async () => ({
    id: 'cat-1', moduleKey: 'identity', documentKey: 'passport', documentName: 'Passport',
  })),
}));
vi.mock('@/lib/vault/moduleCategoryMap', () => ({
  resolveModuleCategory: vi.fn(() => ({ moduleKey: 'identity', documentKey: 'passport' })),
}));
vi.mock('@/lib/records/normalize', () => ({
  toTaxonomyRecord: vi.fn(() => ({ record: {}, searchHashes: {}, masked: {}, reminders: [] })),
  toTaxonomyRecordFromFields: vi.fn(() => ({ record: {}, searchHashes: {}, masked: {}, reminders: [] })),
}));
vi.mock('@/lib/records/categorySpec', () => ({ loadCategoryFieldSpec: vi.fn(async () => []) }));
// Both lists, because `createRecord` reads each for a different purpose: the
// wide one hashes the blind indexes, the narrow one decides duplicates. See
// `dedupeIdentifierFields`. These arms are exercised in duplicateMatch.test.ts;
// here they stay empty so the title and filename arms are what is under test.
vi.mock('@/lib/documentCategoryFields', () => ({
  identifierFields: vi.fn(() => []),
  dedupeIdentifierFields: vi.fn(() => []),
}));
vi.mock('@/lib/vault/fieldSplitter', () => ({
  loadEncryptionPolicy: vi.fn(async () => ({})),
  splitRecordFields: vi.fn(() => ({ open: {}, sealed: {} })),
}));
vi.mock('@/lib/vault/vaultStore', () => ({
  storeRecordInVault: (...a: any[]) => storeRecordInVault(...a),
}));
vi.mock('@/lib/records/upload', () => ({
  uploadRecords: (...a: any[]) => uploadRecords(...a),
  // The file-identity arm asks this before the check runs. These fixtures carry
  // no bytes, so a null hash is the honest answer and the arm stays silent —
  // which is what keeps this file about the title, filename and identifier arms.
  sourceHashFor: vi.fn(async () => null),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({ readJsonStore: vi.fn(async () => ({ store: { records: {} } })) }));
vi.mock('@/lib/records/documentPurge', () => ({
  invalidateAnalysisCache: vi.fn(async () => {}),
  purgeDeletedDocument: vi.fn(async () => {}),
}));

const { createRecord, RecordConflictError, ForbiddenCategoryError, conflictResponsePayload } =
  await import('@/lib/records/handler');

const ctx = {
  user: { id: 'u1', tenantId: 't1', tenant: { id: 't1' } },
  scope: 'documents',
  module: 'identity',
  keys: [{ moduleKey: 'identity', documentKey: 'passport' }],
} as any;

const input = { title: 'Passport', categoryId: 'cat-1', record: {}, holderId: null };
const EXISTING = 'aaaaaaaa-1111-2222-3333-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  conflictUpdates.length = 0;
  hasPermission.mockResolvedValue(true);
  resolveDuplicate.mockResolvedValue(null);
  nextAvailableTitle.mockResolvedValue('Passport (2)');
  storeRecordInVault.mockResolvedValue({
    categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
    filePath: '', fileDriveId: '', jsonDriveId: 'json-1', keyVersion: 1,
    contentHash: '', encryptedSize: 0, pageCount: 0, status: 'active',
  });
});

describe('an upload that duplicates nothing', () => {
  it('creates a new record', async () => {
    await createRecord(ctx, input);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].id).not.toBe(EXISTING);
  });

  it('still asks the question even when the caller confirmed', async () => {
    // The check used to be skipped entirely under `force`. It now always runs:
    // the answer is needed either to refuse, or to know what to overwrite.
    await createRecord(ctx, input, { overwrite: true });

    expect(resolveDuplicate).toHaveBeenCalledTimes(1);
  });
});

describe('an unconfirmed duplicate', () => {
  beforeEach(() => {
    resolveDuplicate.mockResolvedValue({
      id: EXISTING, reason: 'title', detail: 'this title, in this category',
      title: 'Passport', moduleKey: 'identity', documentKey: 'passport',
    });
  });

  it('is refused, naming the record it clashed with', async () => {
    // `existingId` is what lets the caller offer "update that one" rather than
    // a dead end — every route turns this into a 409 carrying it.
    await expect(createRecord(ctx, input)).rejects.toThrow(RecordConflictError);
    await expect(createRecord(ctx, input)).rejects.toMatchObject({ existingId: EXISTING });
  });

  it('writes nothing at all', async () => {
    // Refused BEFORE the vault write, so a rejected duplicate cannot leave
    // ciphertext behind on the tenant's Drive billed against their quota.
    await expect(createRecord(ctx, input)).rejects.toThrow();

    expect(storeRecordInVault).not.toHaveBeenCalled();
    expect(uploadRecords).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });
});

describe('a confirmed duplicate', () => {
  beforeEach(() => {
    resolveDuplicate.mockResolvedValue({
      id: EXISTING, reason: 'title', detail: 'this title, in this category',
      title: 'Passport', moduleKey: 'identity', documentKey: 'passport',
    });
  });

  it('writes onto the existing record instead of adding a second one', async () => {
    // THE rule. The id is the existing record's, so the vault entry is
    // overwritten and the row is reconciled by `onConflictDoUpdate` — there is
    // no second copy anywhere for the two to drift apart in.
    await createRecord(ctx, input, { overwrite: true });

    expect(storeRecordInVault).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: EXISTING }),
    );
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].id).toBe(EXISTING);
    expect(conflictUpdates).toHaveLength(1);
  });

  it('reports that it overwrote something', async () => {
    // The audit trail and the bulk-scan review UI both branch on this: saying
    // "created" would describe a row that was not added, and would hide that
    // existing data was replaced.
    const record: any = await createRecord(ctx, input, { overwrite: true });

    expect(record.replacedExisting).toBe(true);
  });

  it('is refused when the caller may add but not edit', async () => {
    // Nine of the routes reaching here gate on `add`. Overwriting is an EDIT,
    // so without this a member allowed only to file new records could rewrite
    // one they may not touch just by uploading something that collides — and
    // the reply would look like an ordinary success.
    hasPermission.mockImplementation(async (_u: any, _m: string, action: string) => action !== 'edit');

    await expect(createRecord(ctx, input, { overwrite: true }))
      .rejects.toThrow(ForbiddenCategoryError);
    expect(insertedRows).toHaveLength(0);
  });
});

describe('a record is never its own duplicate', () => {
  it('hands the id being edited down to the matcher as an exclusion', async () => {
    // Without this, saving an edit that left the identifier alone would be
    // refused as a copy of itself — the row already carries that blind index.
    await createRecord(ctx, { ...input, replaceId: EXISTING }, { overwrite: false });

    expect(resolveDuplicate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludeId: EXISTING }),
      // The two injected lookups, in order: the blind index and the file hash.
      // Both are passed by `createRecord` rather than imported by the matcher,
      // which is what keeps duplicateMatch.ts free of a cycle back to handler.
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not report a plain edit as having overwritten a duplicate', async () => {
    const record: any = await createRecord(ctx, { ...input, replaceId: EXISTING });

    expect(record.replacedExisting).toBeUndefined();
  });

  it('refuses an edit that collides with a DIFFERENT record, confirmed or not', async () => {
    // The caller named which record to write onto. Letting the confirmation
    // resolve this would either merge two records or leave both claiming the
    // same identifier — the second copy this whole rule exists to prevent. So
    // it is refused whatever the flag says, naming the record that is in the way.
    resolveDuplicate.mockResolvedValue({
      id: 'cccccccc-9999-8888-7777-666666666666',
      reason: 'dedupeField',
      detail: 'this document number',
      title: 'Someone else\u2019s passport',
      moduleKey: 'identity',
      documentKey: 'passport',
    });

    await expect(
      createRecord(ctx, { ...input, replaceId: EXISTING }, { overwrite: true }),
    ).rejects.toThrow(RecordConflictError);
    expect(insertedRows).toHaveLength(0);
  });
});

describe('a duplicate the user chose to keep BOTH of', () => {
  const TITLE_MATCH = {
    id: EXISTING, reason: 'title', detail: 'this title, in this category',
    title: 'Passport', moduleKey: 'identity', documentKey: 'passport',
  };

  beforeEach(() => {
    resolveDuplicate.mockResolvedValue(TITLE_MATCH);
  });

  it('writes a NEW record and leaves the match untouched', async () => {
    // The one case where a second copy is legitimate: the user was shown both
    // documents and said they are different things. The matched record's id
    // must not appear anywhere in the write, or "keep both" would quietly be
    // "keep the new one".
    await createRecord(ctx, input, { keepBoth: true });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].id).not.toBe(EXISTING);
    expect(storeRecordInVault).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: expect.not.stringMatching(EXISTING) }),
    );
  });

  it('files it under the numbered title', async () => {
    // Two rows with one title would be indistinguishable in the list, and the
    // NEXT upload of that name would match whichever was written last — so the
    // pair could never be aimed at deliberately.
    await createRecord(ctx, input, { keepBoth: true });

    expect(nextAvailableTitle).toHaveBeenCalledWith(
      expect.anything(), 't1', 'cat-1', 'Passport',
    );
    expect(insertedRows[0].title).toBe('Passport (2)');
    expect(storeRecordInVault).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Passport (2)' }),
    );
  });

  it('does not report it as having overwritten anything', async () => {
    // The audit trail and the review screens branch on this. A fork added a
    // row; saying it replaced one would describe a write that never happened.
    const record: any = await createRecord(ctx, input, { keepBoth: true });

    expect(record.replacedExisting).toBeUndefined();
  });

  it('does not require edit permission', async () => {
    // A fork touches nothing that already exists — it is exactly the `add` the
    // route gated on. Demanding `edit` here would refuse the fork to the one
    // member for whom keeping both is the only safe answer: someone who may
    // file documents but not change them.
    hasPermission.mockImplementation(
      async (_u: any, _m: string, action: string) => action !== 'edit',
    );

    await createRecord(ctx, input, { keepBoth: true });

    expect(insertedRows).toHaveLength(1);
  });

  it('is refused when the match is on a declared identifier', async () => {
    // Two records claiming one account number cannot be told apart afterwards:
    // the blind-index lookup returns both and resolves to whichever came back
    // first. Refused however the answer arrives, so a client that offers the
    // button anyway cannot produce the pair.
    resolveDuplicate.mockResolvedValue({
      ...TITLE_MATCH, reason: 'dedupeField', detail: 'this document number',
    });

    await expect(createRecord(ctx, input, { keepBoth: true }))
      .rejects.toThrow(RecordConflictError);
    expect(insertedRows).toHaveLength(0);
  });

  it('is refused for an EDIT, which names the record to write onto', async () => {
    // `replaceId` says "update THAT record". An edit cannot also fork itself
    // into a second row — the refusal names the record that is in the way.
    await expect(
      createRecord(ctx, { ...input, replaceId: EXISTING }, { keepBoth: true }),
    ).rejects.toThrow(RecordConflictError);
    expect(insertedRows).toHaveLength(0);
  });

  it('loses to `overwrite` if both somehow arrive', async () => {
    // Contradictory answers are not a coin toss: the narrower outcome wins,
    // because it is the one that cannot leave the tenant with a copy they did
    // not ask for.
    await createRecord(ctx, input, { overwrite: true, keepBoth: true });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].id).toBe(EXISTING);
  });

  it('carries the match on the refusal, so the prompt can show it', async () => {
    // The 409 previews the record it matched. Without the match on the error,
    // every route would be back to a sentence and an id.
    await expect(createRecord(ctx, input)).rejects.toMatchObject({
      match: expect.objectContaining({ id: EXISTING, reason: 'title' }),
    });
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE 409 BODY — WHICH ANSWERS THE PROMPT MAY OFFER                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every write path replies with this one object, and the prompt renders exactly
 * the answers it names. Getting either flag wrong produces a button that 409s
 * straight back — which for an EDIT re-opened the same prompt on the same
 * refusal, a loop rather than a choice.
 */
describe('the refusal every route answers with', () => {
  const user = { id: 'u1', tenantId: 't1', role: 'MEMBER' } as any;
  const match = {
    id: EXISTING,
    reason: 'title',
    detail: 'this title, in this category',
    title: 'Passport',
    moduleKey: 'identity',
    documentKey: 'passport',
    keepBothTitle: 'Passport (2)',
    file: { filePath: '/f', fileName: 'p.pdf', mimeType: 'application/pdf', fileSize: 1, pageCount: 1, updatedAt: null },
  } as any;

  const refusal = (over: any = {}) =>
    Object.assign(new RecordConflictError(EXISTING, "'Passport' already has this title.", 'Passport', match), over);

  it('offers all three answers for an ordinary title clash', async () => {
    const body = await conflictResponsePayload(user, refusal());

    expect(body).toMatchObject({
      requiresConfirmation: true,
      existingId: EXISTING,
      existingTitle: 'Passport',
      keepBothAllowed: true,
      keepBothTitle: 'Passport (2)',
      keepNewAllowed: true,
    });
  });

  it('withdraws both write answers for an EDIT', async () => {
    // The edit routes name their target with `replaceId`, and `createRecord`
    // refuses that collision however it is confirmed — see the assertions
    // above. So neither overwriting nor forking is answerable here.
    const body = await conflictResponsePayload(user, refusal(), {
      allowKeepBoth: false, allowKeepNew: false,
    });

    expect(body.keepBothAllowed).toBe(false);
    expect(body.keepBothTitle).toBeNull();
    expect(body.keepNewAllowed).toBe(false);
    // Still names the record, because that is the only way out of it.
    expect(body.existingTitle).toBe('Passport');
    expect(body.existingModuleKey).toBe('identity');
  });

  it('never forks an identifier clash, whatever the caller allows', async () => {
    const body = await conflictResponsePayload(
      user,
      refusal({ match: { ...match, reason: 'dedupeField', keepBothTitle: null } }),
    );

    expect(body.keepBothAllowed).toBe(false);
    expect(body.keepNewAllowed).toBe(true);
  });

  it('withholds the file from a member who may file into that category but not read it', async () => {
    // `add` does not imply `view`. Handing back a servable URL here would let a
    // member fetch documents by uploading collisions until one matched.
    hasPermission.mockResolvedValue(false);

    const body = await conflictResponsePayload(user, refusal());

    expect(body.existingFile).toBeNull();
    expect(body.existingTitle).toBe('Passport');
  });

  it('degrades to the conservative answers when the thrower carried no match', async () => {
    const bare = new RecordConflictError(EXISTING, 'Already exists', 'Passport');

    const body = await conflictResponsePayload(user, bare);

    expect(body.keepBothAllowed).toBe(false);
    expect(body.keepNewAllowed).toBe(true);
    expect(body.existingFile).toBeNull();
  });
});
