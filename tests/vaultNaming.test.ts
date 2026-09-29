import { describe, it, expect } from 'vitest';

/**
 * Every name the vault writes to Google Drive.
 *
 * These are pure functions, but they are the least forgiving code in the
 * feature: a document whose filename cannot be parsed back is a document nobody
 * can find again, and a category key that reaches the path layer unvalidated
 * is a path traversal into someone else's folder. Builders and parsers are
 * tested as inverses because that is the property that actually has to hold.
 */

import {
  FALLBACK_DOCUMENT_KEY,
  FOLDER_DOCUMENTS,
  FOLDER_JSON,
  FOLDER_BUSINESS,
  FOLDER_PERSONAL,
  buildDocumentFileName,
  buildJsonFileName,
  documentAppProperties,
  documentFolderPath,
  isSafeCategoryKey,
  isVaultModule,
  jsonFolderPath,
  parseDocumentFileName,
  parseJsonFileName,
  passwordCategoryKey,
  slugifyCategory,
} from '@/lib/vault/vaultNaming';

const DOC_ID = '9f2c1a44-8e31-4b02-91da-77c0e5b1a3f9';
const OWNER_ID = '3b71e0c2-5a44-4d19-b8e7-1c2f9a0d6e88';

describe('document file names', () => {
  it('round-trips through build and parse', () => {
    const name = buildDocumentFileName({ documentId: DOC_ID, ownerId: OWNER_ID });
    expect(name).toBe(`doc-${DOC_ID}__uid-${OWNER_ID}.enc`);
    expect(parseDocumentFileName(name)).toEqual({ documentId: DOC_ID, ownerId: OWNER_ID });
  });

  it('carries no document title — filenames are visible in the owner’s Drive UI', () => {
    const name = buildDocumentFileName({ documentId: DOC_ID, ownerId: OWNER_ID });
    // Only ids, separators and the extension. Nothing derived from user input.
    expect(name).toMatch(/^doc-[0-9a-f-]{36}__uid-[0-9a-f-]{36}\.enc$/);
  });

  it('normalises case so a re-parse matches the stored id', () => {
    const name = buildDocumentFileName({
      documentId: DOC_ID.toUpperCase(),
      ownerId: OWNER_ID.toUpperCase(),
    });
    expect(parseDocumentFileName(name)).toEqual({ documentId: DOC_ID, ownerId: OWNER_ID });
  });

  it('refuses to build a name it could not parse back', () => {
    expect(() => buildDocumentFileName({ documentId: 'not-a-uuid', ownerId: OWNER_ID })).toThrow();
    expect(() => buildDocumentFileName({ documentId: DOC_ID, ownerId: '' })).toThrow();
  });

  it('returns null for files that are not ours', () => {
    expect(parseDocumentFileName('holiday-photo.jpg')).toBeNull();
    expect(parseDocumentFileName('documents__identity.pan_card.enc.json')).toBeNull();
    // Right shape, wrong id format — must not be treated as a document.
    expect(parseDocumentFileName('doc-123__uid-456.enc')).toBeNull();
    // Missing the uid half entirely.
    expect(parseDocumentFileName(`doc-${DOC_ID}.enc`)).toBeNull();
  });
});

describe('JSON store names', () => {
  const PAN = { moduleKey: 'identity', documentKey: 'pan_card' };

  it('round-trips through build and parse', () => {
    const name = buildJsonFileName('identity', PAN);
    expect(name).toBe('identity__identity__pan_card.enc.json');
    expect(parseJsonFileName(name)).toEqual({ module: 'identity', categoryKey: PAN });
  });

  it('splits module then key, so underscores inside either half survive', () => {
    // `bank_investments` and `itr_form16` both contain single underscores; the
    // separator is `__`, which neither half can contain.
    const key = { moduleKey: 'bank_investments', documentKey: 'itr_form16' };
    const name = buildJsonFileName('identity', key);
    expect(name).toBe('identity__bank_investments__itr_form16.enc.json');
    expect(parseJsonFileName(name)).toEqual({ module: 'identity', categoryKey: key });
  });

  it('round-trips a password store, whose module half is the reserved key', () => {
    const key = passwordCategoryKey('Banking');
    const name = buildJsonFileName('passwords', key);
    expect(name).toBe('passwords__passwords__banking.enc.json');
    expect(parseJsonFileName(name)).toEqual({ module: 'passwords', categoryKey: key });
  });

  it('rejects unknown modules and unsafe categories', () => {
    expect(() => buildJsonFileName('medicalRecords' as any, PAN)).toThrow();
    expect(() => buildJsonFileName('identity', { moduleKey: '..', documentKey: 'etc' })).toThrow();
    expect(() => buildJsonFileName('identity', { moduleKey: 'a', documentKey: '../passwd' })).toThrow();
    expect(parseJsonFileName('bankInfos__x__y.enc.json')).toBeNull();
    // A pre-0012 dotted name has only one `__` and must not parse.
    expect(parseJsonFileName('documents__identity.pan_card.enc.json')).toBeNull();
  });

  it('keeps the existing .enc.json suffix convention', () => {
    expect(buildJsonFileName('identity', PAN)).toMatch(/\.enc\.json$/);
  });
});

describe('category keys', () => {
  it('accepts the immutable (module_key, document_key) shape', () => {
    expect(isSafeCategoryKey({ moduleKey: 'identity', documentKey: 'pan_card' })).toBe(true);
    expect(isSafeCategoryKey({ moduleKey: 'bank_investments', documentKey: 'itr_form16' })).toBe(true);
    expect(isSafeCategoryKey(passwordCategoryKey(null))).toBe(true);
  });

  it('rejects a dot in either half — that is a pre-0012 code, not a key', () => {
    expect(isSafeCategoryKey({ moduleKey: 'identity.pan_card', documentKey: 'x' })).toBe(false);
    expect(isSafeCategoryKey({ moduleKey: 'x', documentKey: 'identity.pan_card' })).toBe(false);
  });

  it('rejects anything that could escape its folder', () => {
    for (const bad of ['../secrets', 'a/b', './x', '', '.', 'A.B', 'a b', 'a\\b', '.leading']) {
      expect(isSafeCategoryKey({ moduleKey: bad, documentKey: 'ok' })).toBe(false);
      expect(isSafeCategoryKey({ moduleKey: 'ok', documentKey: bad })).toBe(false);
    }
    expect(isSafeCategoryKey({ moduleKey: 'x'.repeat(61), documentKey: 'ok' })).toBe(false);
    expect(isSafeCategoryKey({ moduleKey: 'ok', documentKey: 'x'.repeat(61) })).toBe(false);
  });

  it('rejects a half-built key', () => {
    expect(isSafeCategoryKey({ moduleKey: 'identity' })).toBe(false);
    expect(isSafeCategoryKey({ documentKey: 'pan_card' })).toBe(false);
    expect(isSafeCategoryKey(null)).toBe(false);
    expect(isSafeCategoryKey('identity/pan_card')).toBe(false);
  });

  it('slugifies free-text password categories deterministically', () => {
    // Determinism matters: a category that slugified two ways would silently
    // split one store into two files on Drive.
    expect(slugifyCategory('Email')).toBe('email');
    expect(slugifyCategory('  Net Banking  ')).toBe('net_banking');
    expect(slugifyCategory('Social / Media!')).toBe('social_media');
    expect(slugifyCategory('Email')).toBe(slugifyCategory('email'));
  });

  it('falls back rather than producing an empty or unsafe segment', () => {
    for (const input of ['', '   ', '!!!', '///', null, undefined]) {
      expect(slugifyCategory(input as any)).toBe(FALLBACK_DOCUMENT_KEY);
    }
  });

  it('never emits a slug the path validator would reject', () => {
    const inputs = ['A'.repeat(200), '--__--', 'Ünïcodé Ñame', '你好 world', '2024/25 Tax'];
    for (const input of inputs) {
      const slug = slugifyCategory(input);
      expect(isSafeCategoryKey({ moduleKey: 'passwords', documentKey: slug })).toBe(true);
    }
  });
});

describe('folder paths', () => {
  const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('nests personal files under Personal/', () => {
    /**
     * The root holds account folders and nothing else. Anything that drops the
     * scope segment puts personal records back at the root, beside `Business/`
     * — which is the layout this replaced, and which a company named "JSON"
     * could collide with.
     */
    expect(documentFolderPath({ moduleKey: 'identity', documentKey: 'pan_card' }))
      .toEqual([FOLDER_PERSONAL, FOLDER_DOCUMENTS, 'identity', 'pan_card']);
  });

  it('nests a company under Business/<companyId>/', () => {
    expect(documentFolderPath({ moduleKey: 'biz_tax', documentKey: 'gst_returns' }, { companyId: COMPANY }))
      .toEqual([FOLDER_BUSINESS, COMPANY, FOLDER_DOCUMENTS, 'biz_tax', 'gst_returns']);
    expect(jsonFolderPath('biz_tax', { companyId: COMPANY }))
      .toEqual([FOLDER_BUSINESS, COMPANY, FOLDER_JSON, 'BizTax']);
  });

  it('gives both scopes the same shape below the account folder', () => {
    // The two subtrees differ ONLY in their scope segment. If they ever stop
    // matching, one taxonomy has grown a nesting level the other lacks and
    // every walker over the tree has to special-case which side it is on.
    const personal = documentFolderPath({ moduleKey: 'identity', documentKey: 'pan_card' });
    const company = documentFolderPath(
      { moduleKey: 'biz_tax', documentKey: 'gst_returns' }, { companyId: COMPANY });

    expect(personal.slice(1)).toEqual([FOLDER_DOCUMENTS, 'identity', 'pan_card']);
    expect(company.slice(2)).toEqual([FOLDER_DOCUMENTS, 'biz_tax', 'gst_returns']);
    expect(company).toHaveLength(personal.length + 1); // the <companyId> segment
  });

  it('treats a null or absent company as the personal scope', () => {
    // Callers pass `ctx.companyId`, which is optional. If these ever diverged,
    // half the personal vault would be written to a second tree.
    const key = { moduleKey: 'identity', documentKey: 'pan_card' };
    expect(documentFolderPath(key)).toEqual(documentFolderPath(key, null));
    expect(documentFolderPath(key)).toEqual(documentFolderPath(key, { companyId: null }));
    expect(documentFolderPath(key)).toEqual(documentFolderPath(key, { companyId: undefined }));
  });

  it('refuses a company segment that is not a UUID', () => {
    // The guard that matters: a company NAME reaching here would silently
    // create a whole second folder tree beside the real one, and the name is
    // user-editable so it would move again on the next rename.
    const key = { moduleKey: 'biz_tax', documentKey: 'gst_returns' };
    expect(() => documentFolderPath(key, { companyId: 'Acme Ltd' })).toThrow(/not a UUID/);
    expect(() => documentFolderPath(key, { companyId: '../../etc' })).toThrow(/not a UUID/);
    expect(() => jsonFolderPath('biz_tax', { companyId: 'acme' })).toThrow(/not a UUID/);
  });

  it('puts personal JSON stores at Personal/JSON/<Module>', () => {
    expect(jsonFolderPath('identity')).toEqual([FOLDER_PERSONAL, FOLDER_JSON, 'Identity']);
    expect(jsonFolderPath('passwords')).toEqual([FOLDER_PERSONAL, FOLDER_JSON, 'Passwords']);
  });

  it('names the account folders so neither can be mistaken for a category', () => {
    // Both capitalised, matching `Documents` and `JSON`. A lowercase
    // `business/` beside `Personal/` read as a leftover rather than a pair.
    expect(FOLDER_PERSONAL).toBe('Personal');
    expect(FOLDER_BUSINESS).toBe('Business');
  });

  it('validates the category before it becomes a path segment', () => {
    expect(() => documentFolderPath({ moduleKey: '../../..', documentKey: 'x' })).toThrow();
    expect(() => documentFolderPath({ moduleKey: 'x', documentKey: '../../..' })).toThrow();
  });
});

describe('appProperties', () => {
  it('tags ownership in metadata that survives a rename', () => {
    const props = documentAppProperties({
      tenantId: 'tenant-1',
      documentId: DOC_ID,
      ownerId: OWNER_ID,
      categoryKey: { moduleKey: 'identity', documentKey: 'pan_card' },
    });
    expect(props.dnx_tenant).toBe('tenant-1');
    expect(props.dnx_doc).toBe(DOC_ID);
    expect(props.dnx_uid).toBe(OWNER_ID);
    expect(props.dnx_mk).toBe('identity');
    expect(props.dnx_dk).toBe('pan_card');
  });

  it('carries no record content', () => {
    const props = documentAppProperties({
      tenantId: 't',
      documentId: DOC_ID,
      ownerId: OWNER_ID,
      categoryKey: { moduleKey: 'identity', documentKey: 'pan_card' },
    });
    // Every value is an id, a category key or a constant — nothing user-authored.
    expect(Object.keys(props).every((k) => k.startsWith('dnx_'))).toBe(true);
  });
});

describe('module allowlist', () => {
  it('covers exactly the modules with a vault adapter', () => {
    expect(isVaultModule('identity')).toBe(true);
    expect(isVaultModule('passwords')).toBe(true);
    expect(isVaultModule('bankInfos')).toBe(false);
    expect(isVaultModule(null)).toBe(false);
  });
});

describe('multi-page document file names', () => {
  // A record is one uploaded FILE; that file's pages are separate Drive
  // objects. Without the `f-` segment the name is a pure function of
  // (documentId, ownerId), so page two would overwrite page one in silence.
  const DOC = '11111111-1111-4111-8111-111111111111';
  const OWNER = '22222222-2222-4222-8222-222222222222';
  const FILE_A = '33333333-3333-4333-8333-333333333333';
  const FILE_B = '44444444-4444-4444-8444-444444444444';

  it('gives two pages of one record two distinct names', () => {
    const a = buildDocumentFileName({ documentId: DOC, ownerId: OWNER, fileId: FILE_A });
    const b = buildDocumentFileName({ documentId: DOC, ownerId: OWNER, fileId: FILE_B });
    expect(a).not.toBe(b);
    expect(a).toBe(`doc-${DOC}__f-${FILE_A}__uid-${OWNER}.enc`);
  });

  it('round-trips the file id', () => {
    const name = buildDocumentFileName({ documentId: DOC, ownerId: OWNER, fileId: FILE_A });
    expect(parseDocumentFileName(name)).toEqual({
      documentId: DOC, ownerId: OWNER, fileId: FILE_A,
    });
  });

  it('still reads the two-segment names written before multi-page support', () => {
    const legacy = `doc-${DOC}__uid-${OWNER}.enc`;
    expect(parseDocumentFileName(legacy)).toEqual({ documentId: DOC, ownerId: OWNER });
    // and omitting the fileId still produces exactly that form
    expect(buildDocumentFileName({ documentId: DOC, ownerId: OWNER })).toBe(legacy);
  });

  it('rejects a non-UUID file id rather than writing an unreadable name', () => {
    expect(() => buildDocumentFileName({ documentId: DOC, ownerId: OWNER, fileId: 'page-2' }))
      .toThrow(/fileId is not a UUID/);
  });

  it('rejects a malformed middle segment', () => {
    expect(parseDocumentFileName(`doc-${DOC}__x-${FILE_A}__uid-${OWNER}.enc`)).toBeNull();
    expect(parseDocumentFileName(`doc-${DOC}__f-not-a-uuid__uid-${OWNER}.enc`)).toBeNull();
    expect(parseDocumentFileName(`doc-${DOC}__f-${FILE_A}__f-${FILE_B}__uid-${OWNER}.enc`)).toBeNull();
  });

  it('does not confuse the file id with the owner id', () => {
    const parsed = parseDocumentFileName(
      buildDocumentFileName({ documentId: DOC, ownerId: OWNER, fileId: FILE_A }))!;
    expect(parsed.ownerId).toBe(OWNER);
    expect(parsed.fileId).toBe(FILE_A);
  });
});
