/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/admin/document-fields — creating, configuring and deleting        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The screen is a suggestion; this endpoint is reachable without it. Everything
 * here is a rule that must hold for a caller who never loaded the page.
 *
 * The two that matter most are not obvious:
 *
 *  · A DICTIONARY field can never be deleted. Its key is what already-sealed
 *    ciphertext is stored under in every tenant's vault, and the compiled
 *    dictionary re-declares it on the next spec load — so the button would
 *    appear to work and do nothing. Hide is the real answer.
 *
 *  · RESET must not delete a custom row. PUT removes a row whose every column
 *    is null, on the reasoning that it says nothing. For a custom row the row
 *    IS the field, so that same rule would turn "give me the defaults back"
 *    into a silent delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows the fake `db` hands back, per table-ish query. */
const state: { overrides: any[]; category: any } = {
  overrides: [],
  category: { id: 'cat-1' },
};

const inserted: any[] = [];
const deleted: any[] = [];
let selectCall = 0;

/**
 * A deliberately dumb Drizzle stand-in.
 *
 * Every select resolves to whatever `nextSelect` says, in call order. The route
 * makes a small, fixed number of them and the order is part of what is being
 * asserted — a route that stopped looking up the category, say, would shift the
 * sequence and fail here rather than silently reading the wrong rows.
 */
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
  db: {
    select: () => chain(nextSelect[selectCall++] ?? []),
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        const self: any = {
          onConflictDoUpdate: () => Promise.resolve(),
          then: (res: any) => Promise.resolve().then(res),
        };
        return self;
      },
    }),
    delete: () => ({ where: (w: any) => { deleted.push(w); return Promise.resolve(); } }),
  },
}));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' })),
}));

/**
 * The taxonomy lookup, stubbed to "yes".
 *
 * The route asks the live registry whether the category exists, and the registry
 * asks the database — which would consume one of the scripted `nextSelect`
 * entries above and shift every later query onto the wrong rows. Stubbed rather
 * than scripted because the question is not what this file tests: these are the
 * rules that hold ONCE the category is known to be real. That the registry
 * answers correctly, including for a retired category, is
 * tests/taxonomyRegistry.test.ts.
 */
vi.mock('@/lib/taxonomyRegistry', () => ({
  knownCategory: vi.fn(async () => true),
  invalidateTaxonomy: vi.fn(),
}));
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST, DELETE, PUT } = await import('@/app/api/admin/document-fields/route');

const CATEGORY = { moduleKey: 'identity', documentKey: 'pan_card' };

const post = (body: Record<string, unknown>) => POST(new Request(
  'http://localhost/api/admin/document-fields',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...CATEGORY, ...body }) },
));

const put = (fields: any[]) => PUT(new Request(
  'http://localhost/api/admin/document-fields',
  { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...CATEGORY, fields }) },
));

const del = (fieldKey: string) => DELETE(new Request(
  `http://localhost/api/admin/document-fields?moduleKey=identity&documentKey=pan_card&fieldKey=${fieldKey}`,
  { method: 'DELETE' },
));

beforeEach(() => {
  selectCall = 0;
  inserted.length = 0;
  deleted.length = 0;
  nextSelect = [];
  state.overrides = [];
});

describe('POST — adding a field', () => {
  beforeEach(() => {
    // activeCategory, then the existing-keys read.
    nextSelect = [[state.category], []];
  });

  it('derives the key from the label and never takes one from the caller', () => {
    // A caller that could choose the key could choose `pan_number` and take
    // over the ciphertext already stored under it.
    return post({ fieldLabel: 'Regional Office Code', dataType: 'text' })
      .then((r) => r.json())
      .then((json) => {
        expect(json.success).toBe(true);
        expect(json.fieldKey).toBe('cf_regional_office_code');
      });
  });

  it('seals by default', async () => {
    await post({ fieldLabel: 'Regional Office Code', dataType: 'text' });

    expect(inserted[0]).toMatchObject({ isPii: true, isCustom: true });
  });

  it('refuses a list field with fewer than two choices', async () => {
    const json = await (await post({
      fieldLabel: 'Fuel', dataType: 'select', display: 'dropdown',
      options: [{ value: 'petrol' }],
    })).json();

    expect(json.error).toMatch(/at least two choices/);
  });

  it('refuses choices on a field that is not a list', async () => {
    const json = await (await post({
      fieldLabel: 'Office', dataType: 'text',
      options: [{ value: 'a' }, { value: 'b' }],
    })).json();

    expect(json.error).toMatch(/not a list field/);
  });

  it('refuses an OPEN field whose name would make it vanish from AI payloads', async () => {
    const json = await (await post({
      fieldLabel: 'Login PIN', dataType: 'text', isPii: false,
    })).json();

    expect(json.error).toMatch(/credential/i);
    expect(json.error).toMatch(/Encrypted/);
  });

  it('allows that same name once it is sealed, which is the right answer', async () => {
    const json = await (await post({
      fieldLabel: 'Login PIN', dataType: 'text', isPii: true,
    })).json();

    expect(json.success).toBe(true);
  });

  it('refuses a label with nothing to build a key from', async () => {
    const json = await (await post({ fieldLabel: '!!!', dataType: 'text' })).json();

    expect(json.error).toMatch(/letters or numbers/);
  });

  it('is Super Admin only', async () => {
    const { getUserFromRequest } = await import('@/lib/auth');
    (getUserFromRequest as any).mockResolvedValueOnce({ id: 'u', role: 'TENANT_ADMIN' });

    expect((await post({ fieldLabel: 'X', dataType: 'text' })).status).toBe(403);
  });
});

describe('DELETE', () => {
  it('removes a field the operator added', async () => {
    nextSelect = [[state.category], [{ isCustom: true, fieldLabel: 'Regional Office Code' }]];

    const json = await (await del('cf_regional_office_code')).json();

    expect(json.success).toBe(true);
    expect(deleted).toHaveLength(1);
  });

  it('refuses a field that ships with DocsNX, and says to hide it instead', async () => {
    // THE guard. The key is what sealed ciphertext is stored under, and the
    // dictionary re-declares it on the next load — so deleting it would look
    // like it worked and change nothing.
    nextSelect = [[state.category], [{ isCustom: false, fieldLabel: 'PAN Number' }]];

    const res = await del('pan_number');
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/cannot be deleted/);
    expect(json.error).toMatch(/hide it instead/);
    expect(deleted).toHaveLength(0);
  });

  it('404s on a field that was never configured', async () => {
    nextSelect = [[state.category], []];

    expect((await del('cf_nothing')).status).toBe(404);
  });

  it('is Super Admin only', async () => {
    const { getUserFromRequest } = await import('@/lib/auth');
    (getUserFromRequest as any).mockResolvedValueOnce({ id: 'u', role: 'TENANT_ADMIN' });

    expect((await del('cf_x')).status).toBe(403);
  });
});

describe('PUT — Reset is not a delete', () => {
  it('removes an all-null row for a DICTIONARY field', async () => {
    // activeCategory, then the custom-keys read (none).
    nextSelect = [[state.category], []];

    const json = await (await put([{ fieldKey: 'pan_number' }])).json();

    expect(json.success).toBe(true);
    expect(json.reset).toBe(1);
  });

  it('never removes a custom row, however empty the patch looks', async () => {
    // The row IS the field. Deleting it here would make Reset a silent delete:
    // the operator asks for the defaults back and the field disappears.
    nextSelect = [
      [state.category],
      [{ fieldKey: 'cf_regional_office_code' }],
      [{ fieldLabel: 'Regional Office Code', dataType: 'text' }],
    ];

    const json = await (await put([{ fieldKey: 'cf_regional_office_code' }])).json();

    expect(json.success).toBe(true);
    expect(json.reset).toBe(0);
    expect(deleted).toHaveLength(0);
  });

  it('still refuses a key that is neither declared nor custom', async () => {
    nextSelect = [[state.category], []];

    const res = await put([{ fieldKey: 'made_up_key' }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not declare/);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A RULE THE FORM CANNOT SHOW IS A RULE NOBODY CAN SATISFY               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `holder_name` is answered by the "Belongs to" picker and `custom_fields` by
 * the free-text rows. No form in the app renders either as an input, so:
 *
 *  · MANDATORY has no input to be satisfied on and no input to show its message
 *    under. Setting it on a live tenant (identity/aadhaar_card.holder_name) made
 *    every save of that sub-category fail — bulk scan, single upload and the
 *    sub-category form alike — with the error attached to nothing on screen, so
 *    no record could be filed and the duplicate check never ran.
 *  · IDENTIFIER is nonsense for both: `custom_fields` is a JSON blob, and a
 *    holder's name is neither unique nor stated by the document.
 *
 * fieldValidation.ts now ignores the first; this endpoint is what stops either
 * being SET, including by a caller that never loaded the screen.
 */
describe('PUT — the two fields no form renders', () => {
  beforeEach(() => {
    // activeCategory, then the custom-keys read (none).
    nextSelect = [[state.category], []];
  });

  it('refuses to make holder_name mandatory', async () => {
    const res = await put([{ fieldKey: 'holder_name', isRequired: true }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Belongs-to picker/i);
    expect(inserted).toHaveLength(0);
  });

  it('refuses to make custom_fields mandatory', async () => {
    const res = await put([{ fieldKey: 'custom_fields', isRequired: true }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/free-text rows/i);
  });

  it('refuses to make either of them an identifier', async () => {
    const res = await put([{ fieldKey: 'holder_name', isIdentifier: true }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot identify a record/i);
  });

  it('still accepts every other setting on those rows', async () => {
    // Only two columns are refused. An operator relabelling or reordering
    // `holder_name` is doing something perfectly reasonable.
    const json = await (await put([
      { fieldKey: 'holder_name', fieldLabel: 'Belongs to', sortOrder: 15 },
    ])).json();

    expect(json.success).toBe(true);
    expect(inserted[0][0]).toMatchObject({
      fieldKey: 'holder_name', fieldLabel: 'Belongs to', isRequired: null,
    });
  });

  it('leaves a rendered field free to be mandatory', async () => {
    // Only these two keys are special. The live tenant's OTHER override was
    // `address` required — a field with an input — and rules like it must keep
    // working, or the fix would have traded one broken screen for another.
    const json = await (await put([{ fieldKey: 'father_name', isRequired: true }])).json();

    expect(json.success).toBe(true);
    expect(inserted[0][0]).toMatchObject({ fieldKey: 'father_name', isRequired: true });
  });
});
