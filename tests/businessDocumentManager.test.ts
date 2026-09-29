/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A BUSINESS DOCUMENT KNOWS ITS OWN NUMBER, AND SAYS SO                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * All 84 business sub-categories used to share one of two generic specs, whose
 * only number was a generic `reference_number` — a key deliberately absent from
 * IDENTIFIER_FIELD_KEYS. So `identifierFields()` answered "identified by
 * nothing" for every one of them, `primaryIdentifier()` returned null, and the
 * Document Manager's Number column read '-' for a company's PAN card whose PAN
 * was sitting masked in the store the whole time.
 *
 * Two things had to be true at once for the fix to be safe, and neither is
 * visible from the other:
 *
 *   · every business category must name a number — the point of the change;
 *   · no business category may name a number that DECIDES DUPLICATES — or this
 *     year's trade-licence renewal overwrites last year's certificate and the
 *     twelve GST returns of one year collapse into one. That failure is silent
 *     and unrecoverable, which is why it gets its own test rather than a
 *     comment.
 *
 * The second is what `dedupeIdentifierFields` bought: an identifier gets the
 * blind index, the mask and the Number column, and only a REQUIRED identifier
 * refuses a write. Every business identifier is optional. Assert it, because
 * adding `isRequired: true` to one of them is a one-word edit that would read
 * like an improvement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dedupeIdentifierFields,
  fieldsFor,
  identifierFields,
  stampIdentifiers,
  type FieldSpec,
} from '@/lib/documentCategoryFields';
import { DOCUMENT_CATEGORY_SEED, isBusinessModule } from '@/lib/documentCategories';
import {
  documentDisplay,
  documentFieldList,
  primaryIdentifier,
  type DocMetadata,
} from '@/lib/records/docMetadata';

const BUSINESS = DOCUMENT_CATEGORY_SEED.filter((c) => isBusinessModule(c.moduleKey));
const specOf = (moduleKey: string, documentKey: string) => fieldsFor({ moduleKey, documentKey });
const idsOf = (moduleKey: string, documentKey: string) => identifierFields(specOf(moduleKey, documentKey));
const labelOf = (moduleKey: string, documentKey: string, fieldKey: string) =>
  specOf(moduleKey, documentKey).find((f) => f.fieldKey === fieldKey)?.fieldLabel;

describe('every business sub-category names the number it is known by', () => {
  it('covers all 84 of them, with none left identified by nothing', () => {
    expect(BUSINESS).toHaveLength(84);
    const naked = BUSINESS.filter((c) => idsOf(c.moduleKey, c.documentKey).length === 0);
    expect(naked.map((c) => `${c.moduleKey}/${c.documentKey}`)).toEqual([]);
  });

  it('gives a business PAN card a PAN, not a "Reference Number"', () => {
    // The reported bug, at its narrowest: the user uploaded a company PAN card
    // and the Number column showed '-'.
    expect(idsOf('biz_registration', 'pan_card')[0]).toBe('pan_number');
    expect(labelOf('biz_registration', 'pan_card', 'pan_number')).toBe('PAN');
  });

  it('puts the category’s own number AHEAD of the generic one', () => {
    // `primaryIdentifier` takes the first identifier the record carries, in spec
    // order. Behind `reference_number` the specific field would only ever be
    // reached by a record that left the generic one blank.
    const spec = specOf('biz_tax', 'gst_returns').map((f) => f.fieldKey);
    expect(spec.indexOf('arn_number')).toBeGreaterThan(-1);
    expect(spec.indexOf('arn_number')).toBeLessThan(spec.indexOf('reference_number'));
  });

  it('keeps the module default beside it, rather than replacing it', () => {
    // `specificFieldsFor` returns the category's own fields merged OVER the
    // module default. Returning the category's alone — the obvious refactor —
    // would strip a GST return of its period, its amount and its dates.
    const keys = specOf('biz_tax', 'gst_returns').map((f) => f.fieldKey);
    expect(keys).toEqual(expect.arrayContaining([
      'arn_number', 'issuing_authority', 'issue_date', 'valid_to', 'period', 'amount',
    ]));
  });

  it('relabels the generic number where a category has no key of its own', () => {
    // A board resolution has a resolution number and no dictionary key for it.
    // The category renames `reference_number` rather than inventing a key —
    // same storage, same sealing decision, the document's own word for it.
    expect(idsOf('biz_compliance', 'board_resolutions')).toEqual(['reference_number']);
    expect(labelOf('biz_compliance', 'board_resolutions', 'reference_number'))
      .toBe('Resolution Number');
  });

  it('seals every one of them', () => {
    // A document number is a unique identifier, so the classification rule puts
    // it in the sealed tier. A business identifier landing in the open tier
    // would be a GSTIN in the clear.
    for (const c of BUSINESS) {
      const spec = specOf(c.moduleKey, c.documentKey);
      for (const key of identifierFields(spec)) {
        const field = spec.find((f) => f.fieldKey === key)!;
        expect(field.isPii, `${c.moduleKey}/${c.documentKey}.${key}`).toBe(true);
      }
    }
  });
});

describe('and none of them decides that a write is a duplicate', () => {
  it('leaves every business category with an empty dedupe set', () => {
    // The regression this whole design avoids. A required identifier here means
    // September's GST return is judged a copy of August's and OVERWRITES it.
    for (const c of BUSINESS) {
      const key = { moduleKey: c.moduleKey, documentKey: c.documentKey };
      expect(dedupeIdentifierFields(specOf(c.moduleKey, c.documentKey), key),
        `${c.moduleKey}/${c.documentKey}`).toEqual([]);
    }
  });

  it('because every business identifier is OPTIONAL', () => {
    // The mechanism behind the assertion above, stated separately so a failure
    // says WHICH invariant broke: `dedupeIdentifierFields` filters on
    // `isRequired`, so marking one of these required silently re-arms it.
    for (const c of BUSINESS) {
      const spec = specOf(c.moduleKey, c.documentKey);
      for (const key of identifierFields(spec)) {
        expect(spec.find((f) => f.fieldKey === key)!.isRequired ?? false,
          `${c.moduleKey}/${c.documentKey}.${key} must stay optional`).toBe(false);
      }
    }
  });

  it('while a personal category still refuses a genuine duplicate', () => {
    // The other half: this must not have loosened the personal taxonomy, where
    // one PAN really is one card.
    expect(dedupeIdentifierFields(
      specOf('identity', 'pan_card'), { moduleKey: 'identity', documentKey: 'pan_card' },
    )).toEqual(['pan_number']);
  });
});

describe('records already filed, before the spec is reseeded', () => {
  /**
   * The stored spec in `document_category_fields` predates this change and
   * declares no `isIdentifier` on anything. `loadCategoryFieldSpec` re-applies
   * the classification through `stampIdentifiers` on every read, which is what
   * makes the Number column right for a record filed months ago without waiting
   * for `seed_document_category_fields.ts` to run.
   */
  const storedBeforeTheChange: FieldSpec[] = [
    { fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true },
    { fieldKey: 'reference_number', fieldLabel: 'Reference Number', dataType: 'text', isPii: true },
    { fieldKey: 'issuing_authority', fieldLabel: 'Issued By', dataType: 'text', isPii: false },
  ];

  it('reads the generic number as an identifier on a business category', () => {
    const stamped = stampIdentifiers(storedBeforeTheChange,
      { moduleKey: 'biz_registration', documentKey: 'pan_card' });
    expect(identifierFields(stamped)).toEqual(['reference_number']);
  });

  it('and does NOT on a personal one — the key means nothing there', () => {
    const stamped = stampIdentifiers(storedBeforeTheChange,
      { moduleKey: 'identity', documentKey: 'passport' });
    expect(identifierFields(stamped)).toEqual([]);
  });
});

describe('the Number column, for a company row', () => {
  const spec = specOf('biz_registration', 'pan_card');
  const identifiers = spec.filter((f) => identifierFields(spec).includes(f.fieldKey));
  const row = { companyId: 'c-1', company: { name: 'HSKTechlab' }, holder: null, isGlobal: false };

  it('shows the masked PAN under the label the category gave it', () => {
    const meta: DocMetadata = { open: {}, masked: { pan_number: '••••234F' } };
    const display = documentDisplay(row, meta, identifiers);
    expect(display.number).toBe('••••234F');
    expect(display.numberLabel).toBe('PAN');
    expect(display.numberKey).toBe('pan_number');
  });

  it('falls back to the generic number for a record filed before the change', () => {
    // What the live "PAN -HSK Techlab 1" record looks like: its PAN was typed
    // into the only box the old form offered.
    const meta: DocMetadata = { open: {}, masked: { reference_number: '••••234F' } };
    expect(primaryIdentifier(meta, identifiers)).toEqual({
      key: 'reference_number', label: 'Reference Number', value: '••••234F',
    });
  });

  it('still names the COMPANY as the holder', () => {
    // Unchanged by this work, and asserted because the Number and the Holder are
    // derived side by side and a change to one lands next to the other.
    const meta: DocMetadata = { open: { holder_name: 'Someone Else' }, masked: {} };
    expect(documentDisplay(row, meta, identifiers).holderName).toBe('HSKTechlab');
  });
});

describe('what Share, Print and the exported PDF describe a record with', () => {
  const spec = specOf('biz_tax', 'gst_returns');

  it('lists the category’s fields in spec order, under their real labels', () => {
    // The defect: the Document Manager built this from six hardcoded legacy
    // identity keys, so a GST return shared as a bare title.
    const fields = documentFieldList({
      open: { issuing_authority: 'GSTN', period: 'Q2 FY25-26', amount: '48200', issue_date: '2026-07-11' },
      masked: { arn_number: '••••7788' },
    }, spec);

    expect(fields.map((f) => f.label)).toEqual([
      'ARN', 'Issued By', 'Document Date', 'Period / Year', 'Amount',
    ]);
    expect(fields[0].value).toBe('••••7788');
  });

  it('prefers the MASK over a plaintext copy of the same key', () => {
    // Sharing a document is not a request to decrypt its identifiers. A stale
    // open-tier copy of a key that has since been sealed must not resurface in
    // something the user is about to send to someone else.
    const fields = documentFieldList(
      { open: { arn_number: 'AA0707250012345' }, masked: { arn_number: '••••2345' } }, spec,
    );
    expect(fields.find((f) => f.label === 'ARN')!.value).toBe('••••2345');
  });

  it('omits what is not a fact about the document', () => {
    // The title is the sheet's heading; the holder is answered by
    // `display.holderName`, which knows a business record belongs to the
    // company; the alert lead is a preference the user set in this app.
    const fields = documentFieldList({
      open: {
        document_title: 'GSTR-3B July', holder_name: 'Ravi', alert_days_before: 30,
        custom_fields: '[{"label":"x","value":"y"}]', period: 'Jul 2026',
      },
      masked: {},
    }, spec);
    expect(fields.map((f) => f.label)).toEqual(['Period / Year']);
  });

  it('still lists a value whose field the spec no longer declares', () => {
    // An operator retiring a field must not silently erase data already filed
    // under it from every print-out.
    const fields = documentFieldList({ open: { legacy_thing: 'kept' }, masked: {} }, spec);
    expect(fields).toContainEqual({ label: 'legacy thing', value: 'kept' });
  });

  it('marks dates as dates, so the client can render them in its own locale', () => {
    const fields = documentFieldList({ open: { issue_date: '2026-07-11' }, masked: {} }, spec);
    expect(fields.find((f) => f.label === 'Document Date')).toEqual({
      label: 'Document Date', value: '2026-07-11', dataType: 'date',
    });
  });

  it('skips a field the record simply does not carry', () => {
    expect(documentFieldList({ open: {}, masked: {} }, spec)).toEqual([]);
  });
});

/**
 * ── THE FILE ROUTE'S SECOND QUESTION ───────────────────────────────────────
 *
 * `hasPermission` answers about the TAXONOMY — may this member read
 * `biz_registration/pan_card` at all. Every other route that reaches a company
 * record asks a second question after it: is this member on THIS company's
 * access list. This route did not, because it takes `companyId` off the row
 * rather than from the request and so had no untrusted id to gate — but the
 * document id is still supplied by the caller, and a tenant member holding the
 * business modules by default could fetch any of the tenant's companies' files
 * by addressing one directly.
 */
describe('serving a company record’s bytes', () => {
  const row = {
    id: 'doc-1',
    fileName: 'pan.pdf',
    mimeType: 'application/pdf',
    filePath: '/api/records/biz_registration/doc-1/file',
    categoryModuleKey: 'biz_registration',
    categoryDocumentKey: 'pan_card',
    companyId: 'company-1',
    fileDriveId: 'drive-1',
  };
  const selectChain = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [row] }) }) }),
  };
  vi.doMock('@/lib/db', () => ({
    db: selectChain,
    withTenant: async (_t: string, cb: any) => cb(selectChain),
  }));
  const hasCompanyAccess = vi.fn(async () => true);
  vi.doMock('@/lib/auth', () => ({
    getUserFromRequest: vi.fn(async () => ({
      id: 'u1', tenantId: 't1', role: 'STANDARD', tenant: { id: 't1' },
    })),
    hasPermission: vi.fn(async () => true),
    hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...(a as [])),
  }));
  vi.doMock('@/lib/vault/vaultRecords', () => ({
    readRecord: vi.fn(async () => ({
      pages: [{ page: 1, fileId: 'page-1', mimeType: 'application/pdf' }],
    })),
  }));
  vi.doMock('@/lib/vault/vaultFiles', () => ({
    openDocumentFile: vi.fn(async () => Buffer.from('decrypted')),
  }));

  const get = async () => {
    const { GET } = await import('@/app/api/records/[module]/[id]/file/route');
    return GET(
      new Request('http://localhost/api/records/biz_registration/doc-1/file'),
      { params: Promise.resolve({ module: 'biz_registration', id: 'doc-1' }) },
    );
  };

  beforeEach(() => { hasCompanyAccess.mockClear(); });

  it('serves them to a member of that company', async () => {
    hasCompanyAccess.mockResolvedValue(true);
    const res = await get();
    expect(res.status).toBe(200);
    expect(hasCompanyAccess).toHaveBeenCalledWith(expect.anything(), 'company-1');
  });

  it('refuses a member of the tenant who is not on the company', async () => {
    hasCompanyAccess.mockResolvedValue(false);
    const res = await get();
    // 404, not 403: whether a company holds a record is itself something a
    // member outside that company should not be able to probe for.
    expect(res.status).toBe(404);
  });
});
