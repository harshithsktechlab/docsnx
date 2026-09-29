/**
 * The one definition of "this document already exists".
 *
 * Guards a rule, not a helper: a document must never exist twice. Every write
 * path in the app now asks `resolveDuplicate` the same question, and what it
 * answers decides whether an upload lands on the record already there or forks
 * a second copy beside it. Before this existed the three writers disagreed —
 * `forceSave` skipped the check entirely and so CREATED the duplicate it was
 * asked about, the Documents page compared against only the page of rows it had
 * loaded, and seven scopes compared nothing at all.
 *
 * The identifier list is now handed in by the caller — `identifierFields(spec)`
 * off the sub-category's own field spec — rather than looked up from a legacy
 * scope, so these pass it directly and this module knows nothing about scopes.
 *
 * The arms are tested through the resolver rather than against SQL: what
 * matters is which record comes back and why, not how the predicate was built.
 * `findActiveTwin`'s own predicate is covered in documentDeletion.test.ts,
 * which exercises the same `findTwin` query over the tombstones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveTwin = vi.fn();
const nextAvailableTitle = vi.fn();
const categoryIdFor = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({})),
}));
vi.mock('@/lib/records/documentVisibility', () => ({
  findActiveTwin: (...a: any[]) => findActiveTwin(...a),
  nextAvailableTitle: (...a: any[]) => nextAvailableTitle(...a),
  // The file arm can match a record in a DIFFERENT sub-category, and numbers a
  // keep-both title within THAT one — so it has to turn the matched row's pair
  // back into a category id.
  categoryIdFor: (...a: any[]) => categoryIdFor(...a),
}));

/**
 * What a match carries about the record's FILE when that record owns none.
 *
 * The prompt previews what it matched, so every match reports a file — and a
 * row with no Drive object reports no path at all rather than the stale
 * `file_path` column, which is set on rows whose bytes were never sealed.
 */
const NO_FILE = {
  filePath: null, fileName: null, mimeType: null,
  fileSize: 0, pageCount: 0, updatedAt: null,
};

const { resolveDuplicate, duplicateMessage, keepBothAllowed } =
  await import('@/lib/records/duplicateMatch');

const ctx = (scope: string) => ({
  user: { id: 'u1', tenantId: 't1' },
  scope,
  module: 'identity',
  keys: [{ moduleKey: 'identity', documentKey: 'passport' }],
}) as any;

/** A category whose spec declares `document_number` as its identity. */
const base = {
  categoryId: 'cat-1',
  // Arm 1 is scoped to it, like arms 3 and 4 — see the header.
  categoryKey: { moduleKey: 'identity', documentKey: 'passport' },
  title: 'Passport',
  fileName: 'passport.pdf',
  searchHashes: {} as Record<string, string>,
  identifiers: ['document_number'] as readonly string[],
};

/** Nothing found by either lookup. */
const noHashHit = vi.fn(async () => [] as any[]);

/** One row as `findBySearchHash` now returns it. */
const row = (id: string) => ({
  id, title: 'Ravi\u2019s Passport',
  categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
});

beforeEach(() => {
  vi.clearAllMocks();
  findActiveTwin.mockResolvedValue(null);
  nextAvailableTitle.mockResolvedValue('Passport (2)');
  categoryIdFor.mockResolvedValue('cat-1');
});

describe('the four arms', () => {
  it('matches on a declared identifier through the blind index', async () => {
    // Arm 1. The value is sealed — Postgres cannot read it — so sameness is
    // decided by comparing HMACs, never plaintext.
    const lookup = vi.fn(async () => [row('doc-9')]);
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, searchHashes: { document_number: 'hash-abc' } },
      lookup,
    );

    // The category is part of the question now: arm 1 asks "is there another
    // record OF THIS KIND carrying this number", not "is this number anywhere".
    expect(lookup).toHaveBeenCalledWith(
      expect.anything(), 'document_number', 'hash-abc',
      { moduleKey: 'identity', documentKey: 'passport' },
    );
    expect(match).toEqual({
      id: 'doc-9', reason: 'dedupeField', detail: 'this document number',
      title: 'Ravi\u2019s Passport', moduleKey: 'identity', documentKey: 'passport',
      file: NO_FILE,
      // Two records must never claim one identifier, so this match cannot be
      // forked and there is no name to offer for a copy.
      keepBothTitle: null,
      // Where the write was headed, for the prompt's second half.
      intoModuleKey: 'identity', intoDocumentKey: 'passport',
    });
    // The identifier settled it; there was no need to go on and look at names.
    expect(findActiveTwin).not.toHaveBeenCalled();
  });

  it('matches on the title within the category', async () => {
    // Arm 2 — the rule the Documents page applied client-side, now server-side
    // where pagination cannot hide the row it should have found.
    findActiveTwin.mockResolvedValue({
      id: 'doc-2', title: 'Passport', fileName: 'other.pdf', reason: 'title',
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
    });

    const match = await resolveDuplicate(ctx('documents'), base, noHashHit);
    expect(match).toEqual({
      id: 'doc-2', reason: 'title', detail: 'this title, in this category',
      title: 'Passport', moduleKey: 'identity', documentKey: 'passport',
      file: { ...NO_FILE, fileName: 'other.pdf' },
      // Resolved alongside the match so the prompt can NAME the copy keeping
      // both would file, before the user agrees to it.
      keepBothTitle: 'Passport (2)',
      // Where the write was headed, for the prompt's second half.
      intoModuleKey: 'identity', intoDocumentKey: 'passport',
    });
  });

  it('matches on the filename within the category', async () => {
    findActiveTwin.mockResolvedValue({
      id: 'doc-3', title: 'Something else', fileName: 'passport.pdf', reason: 'fileName',
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
    });

    const match = await resolveDuplicate(ctx('documents'), base, noHashHit);
    expect(match).toEqual({
      id: 'doc-3', reason: 'fileName', detail: 'this file name, in this category',
      title: 'Something else', moduleKey: 'identity', documentKey: 'passport',
      file: { ...NO_FILE, fileName: 'passport.pdf' }, keepBothTitle: 'Passport (2)',
      // Where the write was headed, for the prompt's second half.
      intoModuleKey: 'identity', intoDocumentKey: 'passport',
    });
  });

  it('gives a category with no identifier field a rule all the same', async () => {
    // A prescription or a discharge summary carries no number that identifies
    // it. Before the title and filename arms existed nothing about such a
    // category was ever compared, and every re-upload became a second record.
    findActiveTwin.mockResolvedValue({
      id: 'doc-4', title: 'Blood test', fileName: null, reason: 'title',
      categoryModuleKey: 'health_medical', categoryDocumentKey: 'checkup_reports',
    });

    const match = await resolveDuplicate(
      ctx('medical'),
      { ...base, title: 'Blood test', fileName: null, identifiers: [] },
      noHashHit,
    );
    expect(match?.id).toBe('doc-4');
  });

  it('finds nothing when nothing matches', async () => {
    await expect(resolveDuplicate(ctx('documents'), base, noHashHit)).resolves.toBeNull();
  });
});

describe('precedence', () => {
  it('prefers the identifier over a name collision', async () => {
    // An identifier is a stronger claim of sameness than a title somebody
    // typed, so when both could match, the identifier decides which record is
    // overwritten. Getting this backwards would write a passport's new scan
    // onto whichever unrelated record happened to share its title.
    const lookup = vi.fn(async () => [row('doc-identifier')]);
    findActiveTwin.mockResolvedValue({
      id: 'doc-title', title: 'Passport', fileName: null, reason: 'title',
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
    });

    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, searchHashes: { document_number: 'hash-abc' } },
      lookup,
    );
    expect(match?.id).toBe('doc-identifier');
  });
});

describe('a record is never its own duplicate', () => {
  it('drops the record being edited from the identifier arm', async () => {
    // Saving a record without touching its number must not be refused as a
    // copy of itself — the row it is editing already carries this blind index.
    const lookup = vi.fn(async () => [row('doc-self')]);
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, searchHashes: { document_number: 'h' }, excludeId: 'doc-self' },
      lookup,
    );
    expect(match).toBeNull();
  });

  it('passes the exclusion down to the title and filename arms', async () => {
    await resolveDuplicate(ctx('documents'), { ...base, excludeId: 'doc-self' }, noHashHit);
    expect(findActiveTwin).toHaveBeenCalledWith(
      expect.anything(), 't1', expect.anything(), 'doc-self',
    );
  });
});

describe('what the name arms refuse to guess', () => {
  it('does not match on a title with no category to scope it to', async () => {
    // Both name arms are scoped to one category. Unscoped, "Passport" would
    // match a record filed somewhere else entirely — and overwriting it would
    // rewrite a Drive object in one folder with bytes sealed for another.
    const match = await resolveDuplicate(
      ctx('documents'), { ...base, categoryId: null }, noHashHit,
    );
    expect(match).toBeNull();
    expect(findActiveTwin).not.toHaveBeenCalled();
  });

  it('does not treat a blank title as something to match on', async () => {
    const match = await resolveDuplicate(
      ctx('documents'), { ...base, title: '   ' }, noHashHit,
    );
    expect(match).toBeNull();
    expect(findActiveTwin).not.toHaveBeenCalled();
  });

  it('does not run the identifier arm with no category to scope it to', async () => {
    // This used to assert the opposite — "arm 1 is scope-wide by design: one
    // account number means one account, wherever it was filed". That premise is
    // what made an RC a duplicate of an insurance policy: a number identifies a
    // SUBJECT, and a subject is not a document. Arm 1 is now confined to the
    // candidate's own sub-category, so with no category there is nothing to
    // compare within and the arm is skipped — the same answer arms 3 and 4 give.
    const lookup = vi.fn(async () => [row('doc-5')]);
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, categoryId: null, categoryKey: null, searchHashes: { document_number: 'h' } },
      lookup,
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(match).toBeNull();
  });

  it('skips an identifier the record did not carry a value for', async () => {
    const lookup = vi.fn(async () => [row('doc-6')]);
    await resolveDuplicate(ctx('documents'), { ...base, searchHashes: {} }, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('the message', () => {
  it('names the record the user has to recognise, not the module', async () => {
    // "A utility bills record with this consumer number already exists" left
    // the user hunting for WHICH one. They are being asked to overwrite it.
    expect(duplicateMessage({
      id: 'x', reason: 'dedupeField', detail: 'this consumer number',
      title: 'Electricity — Flat 4B', moduleKey: 'utility_bills', documentKey: 'electricity',
      file: NO_FILE, keepBothTitle: null,
      intoModuleKey: 'utility_bills', intoDocumentKey: 'electricity',
    })).toBe("'Electricity — Flat 4B' already has this consumer number.");
  });
});

describe('what the prompt is given to SHOW', () => {
  it('derives the file URL rather than echoing the stored column', async () => {
    // `documents.file_path` encodes the scope that WROTE the record, not the
    // one that owns its category, so a record filed from the Document Manager
    // into another module's category carries a path that 404s. The URL is
    // rebuilt from the category on the row — see fileUrl.ts.
    findActiveTwin.mockResolvedValue({
      id: 'doc-7', title: 'Passport', fileName: 'passport.pdf', reason: 'title',
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
      fileDriveId: 'drive-1', filePath: '/api/records/wills_estate/doc-7/file',
      mimeType: 'application/pdf', fileSize: 2048, pageCount: 3,
      updatedAt: new Date('2026-03-04T00:00:00Z'),
    });

    const match = await resolveDuplicate(ctx('documents'), base, noHashHit);

    expect(match?.file).toEqual({
      filePath: '/api/records/documents/doc-7/file',
      fileName: 'passport.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      pageCount: 3,
      updatedAt: new Date('2026-03-04T00:00:00Z'),
    });
  });

  it('reports no file for a record whose bytes were never sealed', async () => {
    // A null `file_drive_id` means nothing was ever written to Drive. Those
    // rows still carry a path from an older writer; it points at nothing, and
    // offering it would render an eye icon that can only ever answer 409.
    findActiveTwin.mockResolvedValue({
      id: 'doc-8', title: 'Passport', fileName: null, reason: 'title',
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
      fileDriveId: null, filePath: '/api/records/documents/doc-8/file',
      mimeType: 'application/pdf', fileSize: 0, pageCount: 0, updatedAt: null,
    });

    const match = await resolveDuplicate(ctx('documents'), base, noHashHit);

    expect(match?.file.filePath).toBeNull();
  });

  it("previews the identifier arm's match too", async () => {
    // Arm 1 is the match a user is least able to recognise from a sentence —
    // "a record with this policy number already exists" — so it is the one that
    // most needs showing.
    const lookup = vi.fn(async () => [{
      ...row('doc-9'),
      fileDriveId: 'drive-9', filePath: null,
      fileName: 'policy.pdf', mimeType: 'application/pdf',
      fileSize: 4096, pageCount: 1, updatedAt: new Date('2026-01-02T00:00:00Z'),
    }]);

    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, searchHashes: { document_number: 'hash-abc' } },
      lookup,
    );

    expect(match?.file.filePath).toBe('/api/records/documents/doc-9/file');
    expect(match?.file.fileName).toBe('policy.pdf');
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ARM 2 — THE SAME FILE, WHEREVER IT WAS FILED                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The title and filename arms are scoped to ONE sub-category and the identifier
 * arm needs a number to have been read off the page. So the same PDF re-uploaded
 * under a different name, or filed under a different sub-category, matched
 * nothing — and a category with no identifier field, or a scan whose OCR fumbled
 * the number, quietly kept two copies.
 *
 * `source_hash` is sha256 of the bytes the user handed us, hashed before any
 * page splitting (`sourceHashFor`, records/upload.ts). It needs no taxonomy and
 * no reader.
 */
describe('the file-identity arm', () => {
  /** A row as `findBySourceHash` returns it — filed somewhere else entirely. */
  const elsewhere = {
    id: 'doc-same-bytes',
    title: 'Aadhaar — Ramya',
    categoryModuleKey: 'identity',
    categoryDocumentKey: 'aadhaar_card',
  };

  it('matches identical bytes across sub-categories', async () => {
    // The whole reason the arm exists: neither name arm could see this, because
    // both are confined to the category being written into.
    const bySource = vi.fn(async () => [elsewhere]);
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, sourceHash: 'sha-abc' },
      noHashHit,
      bySource,
    );

    expect(bySource).toHaveBeenCalledWith(expect.anything(), 'sha-abc');
    expect(match?.id).toBe('doc-same-bytes');
    expect(match?.reason).toBe('fileContent');
  });

  it('loses to a declared identifier', async () => {
    // A number the document STATES is the stronger claim, and it is the one
    // that must refuse keep-both. Getting this order wrong would let two
    // records claim one Aadhaar number as long as their bytes differed.
    const byHash = vi.fn(async () => [row('doc-identifier')]);
    const bySource = vi.fn(async () => [elsewhere]);
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, searchHashes: { document_number: 'h' }, sourceHash: 'sha-abc' },
      byHash,
      bySource,
    );

    expect(match?.id).toBe('doc-identifier');
    expect(match?.reason).toBe('dedupeField');
  });

  it('outranks a title collision', async () => {
    // Identical bytes are a stronger claim than a name somebody typed.
    findActiveTwin.mockResolvedValue({
      id: 'doc-title', title: 'Passport', fileName: null, reason: 'title',
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
    });
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, sourceHash: 'sha-abc' },
      noHashHit,
      vi.fn(async () => [elsewhere]),
    );

    expect(match?.id).toBe('doc-same-bytes');
  });

  it('offers keep-both, and numbers it within the MATCHED category', async () => {
    // Unlike an identifier clash, two records built from the same bytes CAN be
    // told apart afterwards — one scan filed for two members is a real thing.
    // The number belongs to the list the second copy would appear in.
    nextAvailableTitle.mockResolvedValue('Passport (2)');
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, sourceHash: 'sha-abc' },
      noHashHit,
      vi.fn(async () => [elsewhere]),
    );

    expect(keepBothAllowed(match!)).toBe(true);
    expect(match?.keepBothTitle).toBe('Passport (2)');
    expect(categoryIdFor).toHaveBeenCalledWith(
      expect.anything(),
      { moduleKey: 'identity', documentKey: 'aadhaar_card' },
    );
  });

  it('is never a record\u2019s own duplicate', async () => {
    // Re-saving a record without replacing its file must not be refused as a
    // copy of itself: the row already carries these exact bytes.
    const match = await resolveDuplicate(
      ctx('documents'),
      { ...base, sourceHash: 'sha-abc', excludeId: 'doc-same-bytes' },
      noHashHit,
      vi.fn(async () => [elsewhere]),
    );

    expect(match).toBeNull();
  });

  it('is silent, not negative, when there is no hash', async () => {
    // A file-less record and every row written before the column existed. The
    // arm must fall through to the name arms rather than swallow the check.
    const bySource = vi.fn(async () => [elsewhere]);
    const match = await resolveDuplicate(ctx('documents'), base, noHashHit, bySource);

    expect(bySource).not.toHaveBeenCalled();
    expect(match).toBeNull();
  });

  it('says what it matched in words the user can act on', async () => {
    // "already has the same file" would read as though the record merely
    // carried an attachment. It IS this file.
    expect(duplicateMessage({
      id: 'x', reason: 'fileContent', detail: 'the same file',
      title: 'Aadhaar \u2014 Ramya', moduleKey: 'identity', documentKey: 'aadhaar_card',
      file: NO_FILE, keepBothTitle: 'Aadhaar \u2014 Ramya (2)',
      intoModuleKey: 'identity', intoDocumentKey: 'aadhaar_card',
    })).toBe("'Aadhaar \u2014 Ramya' is this same file.");
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE LIST ARM 1 IS HANDED, AND WHY IT IS NOT `identifierFields`         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Arm 1 reaches across the caller's whole permitted set, not one category —
 * "one account number means one account, wherever it was filed". That reading is
 * true of an account number and false of a car.
 *
 * A registration number is declared by four categories: the RC STATES it, while
 * the PUC certificate and the insurance policy QUOTE it. `withIdentifier` stamps
 * per KEY, so all four were identifiers, and saving a PUC was refused as a
 * duplicate of the RC — with no "keep both" offered, since arm 1 correctly
 * withholds it. It was never an identifier clash.
 *
 * These wire the real seeds to the real resolver, because the bug lived in the
 * join between them: each half was behaving exactly as written.
 */
const { DOCUMENT_CATEGORY_FIELD_SEED, dedupeIdentifierFields } =
  await import('@/lib/documentCategoryFields');

describe('one car, three documents, three records', () => {
  const identifiersFor = (moduleKey: string, documentKey: string) =>
    dedupeIdentifierFields(
      DOCUMENT_CATEGORY_FIELD_SEED.filter(
        (r) => r.moduleKey === moduleKey && r.documentKey === documentKey,
      ),
      { moduleKey, documentKey },
    );

  /** Every category a caller holding the whole vehicle module can write. */
  const carCtx = () => ({
    user: { id: 'u1', tenantId: 't1' },
    scope: 'documents',
    module: 'vehicle',
    keys: [
      { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
      { moduleKey: 'vehicle', documentKey: 'puc_certificate' },
      { moduleKey: 'insurance', documentKey: 'vehicle_policies' },
    ],
  }) as any;

  const KEY = {
    rc: { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
    puc: { moduleKey: 'vehicle', documentKey: 'puc_certificate' },
    policy: { moduleKey: 'insurance', documentKey: 'vehicle_policies' },
  };

  /** One car. Every document about it states this. */
  const REG = { registration_number: 'hash-MH12AB1234' };

  /**
   * `findBySearchHash` as it now behaves: scoped to the category it is asked
   * about, and matching on the field within it.
   *
   * Modelling the scope in the mock is the point. A mock that ignored the
   * category would answer for records of a different KIND, which is the bug
   * these tests exist to hold shut.
   */
  const store = (rows: any[]) => vi.fn(
    async (_ctx: any, fieldKey: string, hash: string, categoryKey: any) => rows.filter(
      (r) => r.categoryModuleKey === categoryKey.moduleKey
        && r.categoryDocumentKey === categoryKey.documentKey
        && r.hashes[fieldKey] === hash,
    ),
  );

  const POLICY_ON_FILE = {
    id: 'pol-1', title: 'Swift Insurance',
    categoryModuleKey: 'insurance', categoryDocumentKey: 'vehicle_policies',
    // The policy carries the registration number too — blind-indexed on
    // purpose, so the car's paperwork stays searchable by it. That it ANSWERS
    // for the key while the RC ASKS about it is exactly what refused the RC.
    hashes: { ...REG, policy_number: 'hash-pol-42' },
  };
  const RC_ON_FILE = {
    id: 'rc-1', title: 'Swift RC',
    categoryModuleKey: 'vehicle', categoryDocumentKey: 'registration_certificate',
    hashes: { ...REG },
  };

  it('files an RC even though the insurance policy states the same number', async () => {
    // The reported bug. The tenant held one record — the policy — and the RC
    // was refused against it, with no keep-both to answer.
    const lookup = store([POLICY_ON_FILE]);
    const match = await resolveDuplicate(carCtx(), {
      categoryId: 'cat-rc',
      categoryKey: KEY.rc,
      title: 'Swift RC',
      fileName: 'rc.pdf',
      searchHashes: REG,
      identifiers: identifiersFor('vehicle', 'registration_certificate'),
    }, lookup);

    expect(match).toBeNull();
    // It DID ask — the RC really is identified by its registration number.
    // The policy simply is not a record of the same kind.
    expect(lookup).toHaveBeenCalledWith(
      expect.anything(), 'registration_number', 'hash-MH12AB1234', KEY.rc,
    );
  });

  it('files a PUC beside both of them', async () => {
    const lookup = store([POLICY_ON_FILE, RC_ON_FILE]);
    const match = await resolveDuplicate(carCtx(), {
      categoryId: 'cat-puc',
      categoryKey: KEY.puc,
      title: 'Swift PUC',
      fileName: 'puc.pdf',
      searchHashes: { ...REG, certificate_number: 'hash-puc-77' },
      identifiers: identifiersFor('vehicle', 'puc_certificate'),
    }, lookup);

    expect(match).toBeNull();
    // A PUC is identified by its certificate number, never by the car's.
    expect(lookup).toHaveBeenCalledWith(
      expect.anything(), 'certificate_number', 'hash-puc-77', KEY.puc,
    );
    expect(lookup).not.toHaveBeenCalledWith(
      expect.anything(), 'registration_number', expect.anything(), expect.anything(),
    );
  });

  it('still refuses a SECOND RC for the same car, and still refuses to fork it', async () => {
    // The half that must not move. Two RCs for one registration number ARE one
    // document, and the pair could never be reconciled afterwards — which is
    // why keep-both is withheld from an identifier match.
    const lookup = store([POLICY_ON_FILE, RC_ON_FILE]);
    const match = await resolveDuplicate(carCtx(), {
      categoryId: 'cat-rc',
      categoryKey: KEY.rc,
      title: 'Swift RC (rescan)',
      fileName: 'rc-scan.pdf',
      searchHashes: REG,
      identifiers: identifiersFor('vehicle', 'registration_certificate'),
    }, lookup);

    expect(match?.id).toBe('rc-1');
    expect(match?.reason).toBe('dedupeField');
    expect(keepBothAllowed(match!)).toBe(false);
    expect(match?.keepBothTitle).toBeNull();
  });

  it('does not make a PUC a duplicate of a domicile certificate', async () => {
    // Eight categories are identified by `certificate_number`, from different
    // issuers with unrelated numbering. Being required on both sides is no
    // longer enough to collide — they are not the same kind of document.
    const lookup = store([{
      id: 'dom-1', title: 'Domicile Certificate',
      categoryModuleKey: 'civil_government', categoryDocumentKey: 'domicile_certificate',
      hashes: { certificate_number: 'hash-12345' },
    }]);
    const match = await resolveDuplicate({
      ...carCtx(),
      keys: [
        { moduleKey: 'vehicle', documentKey: 'puc_certificate' },
        { moduleKey: 'civil_government', documentKey: 'domicile_certificate' },
      ],
    }, {
      categoryId: 'cat-puc',
      categoryKey: KEY.puc,
      title: 'Swift PUC',
      fileName: 'puc.pdf',
      searchHashes: { certificate_number: 'hash-12345' },
      identifiers: identifiersFor('vehicle', 'puc_certificate'),
    }, lookup);

    expect(match).toBeNull();
  });

  it('lets one car keep this year’s PUC and last year’s', async () => {
    // Category scope alone would NOT save this: both are PUCs. It is the
    // required-rule that keeps `registration_number` out of a PUC's identity,
    // so the two are told apart by their certificate numbers.
    const lookup = store([{
      id: 'puc-2024', title: 'Swift PUC 2024',
      categoryModuleKey: 'vehicle', categoryDocumentKey: 'puc_certificate',
      hashes: { ...REG, certificate_number: 'hash-puc-2024' },
    }]);
    const match = await resolveDuplicate(carCtx(), {
      categoryId: 'cat-puc',
      categoryKey: KEY.puc,
      title: 'Swift PUC 2025',
      fileName: 'puc-2025.pdf',
      searchHashes: { ...REG, certificate_number: 'hash-puc-2025' },
      identifiers: identifiersFor('vehicle', 'puc_certificate'),
    }, lookup);

    expect(match).toBeNull();
  });

  it('lets one meter be billed every month', async () => {
    // And the third rule: `consumer_number` is REQUIRED on a utility bill and
    // is the meter’s identity, so neither category scope nor the required-rule
    // saves it — RECURRING_SUBJECT_IDENTIFIERS does.
    const key = { moduleKey: 'utility_bills', documentKey: 'electricity' };
    const lookup = store([{
      id: 'bill-jan', title: 'Electricity — January',
      categoryModuleKey: 'utility_bills', categoryDocumentKey: 'electricity',
      hashes: { consumer_number: 'hash-meter-9' },
    }]);
    const match = await resolveDuplicate({
      user: { id: 'u1', tenantId: 't1' },
      scope: 'documents',
      module: 'utility_bills',
      keys: [key],
    } as any, {
      categoryId: 'cat-elec',
      categoryKey: key,
      title: 'Electricity — February',
      fileName: 'feb.pdf',
      searchHashes: { consumer_number: 'hash-meter-9' },
      identifiers: identifiersFor('utility_bills', 'electricity'),
    }, lookup);

    expect(match).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});
