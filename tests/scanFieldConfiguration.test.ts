/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   BULK SCAN READS EACH DOCUMENT AGAINST ITS OWN CATEGORY'S FIELDS        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────
 * `/api/ai/scan` asked the model for a hardcoded five-key block —
 * `documentNumber`, `idHolderName`, `dob`, `fatherName`, `expiryDate` —
 * identically for all 83 sub-categories, and the review grid rendered those
 * five inputs for every record. So a super admin's Field Configuration
 * (/admin/document-fields) reached the module form and the Documents Manager
 * and reached bulk scan not at all: a relabelled field never appeared, a
 * retired one could still be written, a required one was never enforced, and
 * a field the operator turned OCR off for was read anyway.
 *
 * Bulk scan now runs a SECOND pass per document record, through the same
 * `runAutofill` the single-document routes use, against the spec
 * `loadCategoryFieldSpec` resolves — which is where the overrides are applied.
 *
 * These tests pin the two seams where that can be asserted without a database:
 * what the extraction prompt ASKS for, and what the save route WRITES.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanRecordErrors } from '@/app/components/ScanRecordFields';
import { visibleFields } from '@/app/components/CategoryFieldInputs';
import { applyOverrides } from '@/lib/records/fieldOverrides';
import { ocrFieldKeys } from '@/lib/documentCategoryFields';
import type { FieldSpec } from '@/lib/documentCategoryFields';

/** A category's compiled spec, before an operator has touched it. */
const SPECS: FieldSpec[] = [
  { fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true },
  { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true, isRequired: true, isIdentifier: true },
  { fieldKey: 'father_name', fieldLabel: "Father's Name", dataType: 'text', isPii: true },
  { fieldKey: 'issue_date', fieldLabel: 'Issue Date', dataType: 'date', isPii: false },
  { fieldKey: 'internal_ref', fieldLabel: 'Internal Ref', dataType: 'text', isPii: false },
];

const map = (o: Record<string, any>) => new Map(Object.entries(o));

/**
 * The ask-list the second pass builds.
 *
 * `extractCategoryFields` runs exactly this — `ocrFieldKeys` over the spec IT
 * was handed — so asserting on the pair asserts on the prompt without needing
 * a model. The spec it is handed is `applyOverrides(compiled, overrides)`,
 * which is what `loadCategoryFieldSpec` returns.
 */
const asked = (overrides: Map<string, any>) =>
  ocrFieldKeys(applyOverrides(SPECS, overrides));

describe('what the second pass asks the document for', () => {
  it('asks for the category’s own fields, not five camelCase names', () => {
    // The whole point. `documentNumber`/`idHolderName`/`dob`/`fatherName`/
    // `expiryDate` were the five keys asked of every category; the ask-list is
    // now the category's own field keys.
    const keys = asked(new Map());

    expect(keys).toContain('pan_number');
    expect(keys).toContain('father_name');
    for (const legacy of ['documentNumber', 'idHolderName', 'dob', 'fatherName', 'expiryDate']) {
      expect(keys).not.toContain(legacy);
    }
  });

  it('never asks for a field the operator retired', () => {
    // `isHidden` DROPS the field from the spec — see applyOverrides — so it is
    // not asked for, not rendered, and refused on write. The key survives in
    // the stored spec so already-sealed values stay retrievable.
    expect(asked(map({ father_name: { isHidden: true } }))).not.toContain('father_name');
    expect(asked(new Map())).toContain('father_name');
  });

  it('never asks for a field the operator turned OCR off for', () => {
    // `isPrinted: false` says "this is not printed on the document" — asking
    // for it spends tokens on a question with no answer, and invites a guess.
    expect(asked(map({ internal_ref: { isPrinted: false } }))).not.toContain('internal_ref');
    expect(asked(new Map())).toContain('internal_ref');
  });

  it('asks under the label the operator chose', () => {
    // The prompt names each field by `fieldLabel`, so a relabel has to reach
    // the spec the ask-list is built from or the model is told the old name.
    const spec = applyOverrides(SPECS, map({ pan_number: { fieldLabel: 'Permanent Account Number' } }));
    const pan = spec.find((f) => f.fieldKey === 'pan_number')!;

    expect(pan.fieldLabel).toBe('Permanent Account Number');
    expect(ocrFieldKeys(spec)).toContain('pan_number');
  });
});

// ─── What the save route writes ──────────────────────────────────────────────

const createRecord = vi.fn();

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/db/schema', () => ({ todos: {}, emergencyContacts: {} }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN',
    tenant: { id: 't1', googleDriveEnabled: true, googleDriveTokens: '{}' },
  })),
  hasPermission: vi.fn(async () => true),
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
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

vi.mock('@/lib/records/handler', () => ({
  createRecord: (...a: any[]) => createRecord(...a),
  recordContextFor: vi.fn(async () => ({ user: { id: 'u1', tenantId: 't1' }, keys: [] })),
  canAnyInScope: vi.fn(async () => true),
  RecordConflictError: class extends Error {},
  conflictResponsePayload: () => ({}),
}));
// The route derives the destination from the RESOLVED category, so this stub
// answers for the PAN card the resolver below returns.
vi.mock('@/lib/records/registry', () => ({
  isRecordScope: () => true,
  scopeForCategory: () => 'documents',
}));
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: vi.fn(async () => ({
    id: 'cat-1', moduleKey: 'identity', documentKey: 'pan_card', documentName: 'PAN Card',
  })),
}));
vi.mock('@/lib/vault/vaultMode', () => ({ usesVault: () => true }));
vi.mock('@/lib/profileUpdater', () => ({ autoUpdateProfile: vi.fn(async () => {}) }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/vault/vaultErrors', () => ({ vaultErrorResponse: () => null }));

const { POST } = await import('@/app/api/ai/scan/save/route');

function save(records: any[]) {
  return POST(new Request('http://localhost/api/ai/scan/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records, files: [] }),
  }));
}

/** The body a record's write was actually given. */
const writtenInput = () => createRecord.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  createRecord.mockResolvedValue({ id: 'doc-1', title: 'PAN Card' });
});

describe('what /api/ai/scan/save writes for a document', () => {
  const scanned = {
    category: 'document',
    title: 'PAN Card',
    fileIndices: [],
    extractedData: {
      categoryId: 'cat-1',
      moduleKey: 'identity',
      documentKey: 'pan_card',
      name: 'PAN Card',
      fields: { document_title: 'Arjun PAN', pan_number: 'ABCDE1234F' },
    },
  };

  it('passes the taxonomy-keyed body straight through', async () => {
    await save([scanned]);

    expect(writtenInput().record).toEqual({
      document_title: 'Arjun PAN', pan_number: 'ABCDE1234F',
    });
  });

  it('flags it as taxonomy-keyed, so the spec is the allowlist', async () => {
    // THE guard. Without `taxonomyFields`, `createRecord` reads the body as the
    // legacy camelCase bag and `toTaxonomyRecord` passes unrecognised keys
    // through untouched — which is how a snake_case key no encryption policy
    // classifies would land in the OPEN tier, in the clear.
    await save([scanned]);

    expect(writtenInput().taxonomyFields).toBe(true);
  });

  it('takes its title from the field the reviewer actually edited', async () => {
    // `document_title` is a spec field of every category and is what the review
    // grid renders. The classifier's `name` is only the fallback.
    await save([scanned]);

    expect(writtenInput().title).toBe('Arjun PAN');
  });

  it('falls back to the proposed name when the title field is empty', async () => {
    await save([{ ...scanned, extractedData: { ...scanned.extractedData, fields: {} } }]);

    expect(writtenInput().title).toBe('PAN Card');
  });

  it('speaks taxonomy for EVERY record module, not only documents', async () => {
    /**
     * The other sixteen scan categories used to arrive here as legacy camelCase
     * bags with `taxonomyFields: false`, because pass 1 never gave them a
     * sub-category and so had nothing to read their fields against. That was
     * the whole "no category, no fields" report: a bank statement posted seven
     * hand-written keys, none of which the spec had ever seen, and no
     * super-admin configuration applied to any of it.
     *
     * Pass 1 files every record against the taxonomy now, so the body is
     * already spec-keyed and the spec is the allowlist for all of them.
     */
    await save([{
      category: 'bank',
      title: 'HDFC',
      fileIndices: [],
      extractedData: {
        categoryId: 'cat-1',
        fields: { document_title: 'HDFC Statement', account_number: '00112233' },
      },
    }]);

    expect(writtenInput().taxonomyFields).toBe(true);
    expect(writtenInput().record).toEqual({
      document_title: 'HDFC Statement', account_number: '00112233',
    });
  });

  it('files it where its CATEGORY says, not where the client claimed', async () => {
    // `category` is a derived value the browser echoes back; the authority is
    // the resolved pair. A row re-filed in the review grid must be written —
    // and permission-checked — in the scope its new category belongs to, so the
    // route reports the scope it actually used rather than the one it was sent.
    const res = await save([{
      category: 'bank',
      title: 'PAN Card',
      fileIndices: [],
      extractedData: { categoryId: 'cat-1', fields: {} },
    }]);

    expect((await res.json()).results[0].category).toBe('document');
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE GRID MAY ONLY REFUSE ON A FIELD IT DREW                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Save runs `scanRecordErrors` per row and refuses the WHOLE batch when any row
 * answers with something, so an error on a field the grid does not render is
 * not a validation message — it is a batch nobody can ever save.
 *
 * That is what shipped: `scanRecordErrors` judged the whole spec while
 * <ScanRecordFields> rendered `formFields(spec)`. An operator marking
 * `holder_name` mandatory (which one did, on identity/aadhaar_card) produced
 * "1 record needs attention — check the fields marked below" with nothing
 * marked below, forever — and because the batch never reached the save route,
 * the duplicate check never ran either.
 */
describe('the bulk-scan grid, on a category configured with a hidden mandatory field', () => {
  const withHiddenRequired: FieldSpec[] = [
    ...SPECS,
    // Exactly the override found on the live tenant.
    { fieldKey: 'holder_name', fieldLabel: 'Holder Name', dataType: 'text', isPii: false, isRequired: true },
  ];

  it('does not refuse the batch over a field it never drew', () => {
    const errors = scanRecordErrors(withHiddenRequired, {
      document_title: 'Aadhaar Detail Specimen',
      pan_number: 'ABCDE1234F',
    });

    expect(errors).toEqual({});
  });

  it('still refuses a rendered field that is genuinely empty', () => {
    // The guard must not become "never validate anything": a mandatory field
    // with an input keeps its rule, and the reviewer can see where to fix it.
    const errors = scanRecordErrors(withHiddenRequired, {
      document_title: 'Aadhaar Detail Specimen',
    });

    expect(errors.pan_number).toMatch(/required/i);
    expect(errors.holder_name).toBeUndefined();
  });

  it('every key it reports is one <CategoryFieldInputs> renders', () => {
    // The invariant behind both cases above, stated once. An error the grid
    // cannot place is an error the reviewer cannot act on.
    const errors = scanRecordErrors(withHiddenRequired, {});
    const rendered = new Set(visibleFields(withHiddenRequired).map((f) => f.fieldKey));

    for (const key of Object.keys(errors)) expect(rendered.has(key), key).toBe(true);
  });
});
