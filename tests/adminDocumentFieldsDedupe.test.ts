/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/admin/document-fields GET — what the screen is told about         ║
 * ║   duplicates                                                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The Identifier checkbox answers "is this indexed?". Whether a match REFUSES
 * a write is a different question with a different answer, and for a long
 * time the screen implied they were one. These pin the three facts the GET
 * now returns per field so the screen can tell the truth:
 *
 *   · `effective.identifiesRecord` — does it decide duplicates, as configured
 *   · `effective.dedupeSource`     — 'admin' (an override row said so) or 'rule'
 *   · `effective.dedupeWhyNot`     — for an indexed field the rule keeps out,
 *                                    which half of the rule did it
 *   · `default.identifiesRecord` / `default.dedupeWhyNot` — the shipped answer,
 *                                    which Reset restores
 *
 * Same fake `db` as tests/customFieldRoutes.test.ts: selects resolve in call
 * order, and the order is part of what is asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let selectCall = 0;
let nextSelect: any[][] = [];

function chain(rows: any[]) {
  const self: any = {
    from: () => self,
    innerJoin: () => self,
    leftJoin: () => self,
    where: () => self,
    orderBy: () => self,
    limit: () => Promise.resolve(rows),
    then: (res: any) => Promise.resolve(rows).then(res),
  };
  return self;
}

vi.mock('@/lib/db', () => ({
  db: { select: () => chain(nextSelect[selectCall++] ?? []) },
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' })),
}));
vi.mock('@/lib/taxonomyRegistry', () => ({
  knownCategory: vi.fn(async () => true),
  invalidateTaxonomy: vi.fn(),
}));

const { GET } = await import('@/app/api/admin/document-fields/route');

/**
 * The GET's selects, in order: the stored spec (empty → compiled dictionary),
 * the overrides read inside `loadCategoryFieldSpec`, the overrides read again
 * by the route, the category row, the live-record count, the change stamps.
 */
function script(overrides: any[]) {
  nextSelect = [[], overrides, overrides, [{ id: 'cat-1' }], [{ count: 0 }], []];
}

async function load(moduleKey: string, documentKey: string, overrides: any[] = []) {
  script(overrides);
  const res = await GET(new Request(
    `http://localhost/api/admin/document-fields?moduleKey=${moduleKey}&documentKey=${documentKey}`,
  ));
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return (key: string) => json.fields.find((f: any) => f.fieldKey === key);
}

const override = (fieldKey: string, patch: Record<string, unknown>) => ({
  fieldKey, fieldLabel: null, dataType: null, isPii: null, isRequired: null, isPrinted: null,
  isIdentifier: null, isHidden: null, sortOrder: null, validation: null, description: null,
  display: null, options: null, isReminder: null, alertDaysBefore: null, isCustom: false,
  ...patch,
});

beforeEach(() => { selectCall = 0; });

describe('an identifier the rule keeps out of the duplicate check', () => {
  it('is reported as indexed only, with the reason', async () => {
    // A PUC quotes the car's registration number: indexed, optional, and so
    // not this record's identity by the rule.
    const field = await load('vehicle', 'puc_certificate');
    const f = field('registration_number');
    expect(f.effective.isIdentifier).toBe(true);
    expect(f.effective.identifiesRecord).toBe(false);
    expect(f.effective.dedupeSource).toBe('rule');
    expect(f.effective.dedupeWhyNot).toBe('optional');
    expect(f.default.identifiesRecord).toBe(false);
    expect(f.default.dedupeWhyNot).toBe('optional');
  });

  it('names the recurring-subject exclusion where that is the reason', async () => {
    const field = await load('utility_bills', 'electricity');
    const f = field('consumer_number');
    expect(f.effective.isIdentifier).toBe(true);
    expect(f.effective.isRequired).toBe(true);
    expect(f.effective.identifiesRecord).toBe(false);
    expect(f.effective.dedupeWhyNot).toBe('recurringSubject');
  });

  it('decides once the operator has confirmed it, and says who said so', async () => {
    // The override REPEATS the dictionary flag — and that is the whole point:
    // the flag is per key, the confirmation is per record.
    const field = await load('vehicle', 'puc_certificate', [
      override('registration_number', { isIdentifier: true }),
    ]);
    const f = field('registration_number');
    expect(f.effective.identifiesRecord).toBe(true);
    expect(f.effective.dedupeSource).toBe('admin');
    expect(f.effective.dedupeWhyNot).toBeNull();
    // What Reset would restore is unchanged.
    expect(f.default.identifiesRecord).toBe(false);
  });
});

describe('an identifier the rule accepts', () => {
  it('decides by the rule, with nothing held against it', async () => {
    const field = await load('vehicle', 'registration_certificate');
    const f = field('registration_number');
    expect(f.effective.identifiesRecord).toBe(true);
    expect(f.effective.dedupeSource).toBe('rule');
    expect(f.effective.dedupeWhyNot).toBeNull();
    expect(f.default.identifiesRecord).toBe(true);
  });

  it('stops deciding when the operator unticks it', async () => {
    const field = await load('vehicle', 'registration_certificate', [
      override('registration_number', { isIdentifier: false }),
    ]);
    const f = field('registration_number');
    expect(f.effective.isIdentifier).toBe(false);
    expect(f.effective.identifiesRecord).toBe(false);
    expect(f.effective.dedupeSource).toBe('admin');
    // Not indexed at all now, so there is no rule to have an objection.
    expect(f.effective.dedupeWhyNot).toBeNull();
  });
});

describe('a business category', () => {
  // Every business identifier is optional by design, so the rule dedupes none
  // of them — the screen must say so, and the operator's tick must fix it,
  // exactly as on the personal tab.
  it('shows its number as indexed only', async () => {
    const field = await load('biz_tax', 'gst_registration');
    const f = field('gstin');
    expect(f.effective.isIdentifier).toBe(true);
    expect(f.effective.identifiesRecord).toBe(false);
    expect(f.effective.dedupeWhyNot).toBe('optional');
  });

  it('dedupes on it once confirmed', async () => {
    const field = await load('biz_tax', 'gst_registration', [
      override('gstin', { isIdentifier: true }),
    ]);
    const f = field('gstin');
    expect(f.effective.identifiesRecord).toBe(true);
    expect(f.effective.dedupeSource).toBe('admin');
  });
});
