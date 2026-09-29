/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/admin/document-categories — creating and retiring a category      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The screen is a suggestion; this endpoint is reachable without it. Everything
 * here is a rule that must hold for a caller who never loaded the page, and the
 * four that matter most are permanent if broken:
 *
 *  · THE SERVER OWNS THE KEY. A caller who could choose it could choose
 *    `pan_card` and take over the Drive folder every tenant's identity
 *    ciphertext already lives in.
 *  · A KEY IS NEVER CHANGED. Not by any verb, at any time.
 *  · NOTHING IS DELETED. `documents.category_id` is ON DELETE RESTRICT.
 *  · A NEW CATEGORY GETS ITS BASELINE FIELDS. Without them its add form renders
 *    empty and every save of it is refused for a missing `document_title`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let selectResults: any[][] = [];
let selectCall = 0;
const inserted: { table: string; values: any }[] = [];
const updated: any[] = [];
let role = 'SUPER_ADMIN';

function chain(rows: any[]) {
  const self: any = {
    from: () => self,
    innerJoin: () => self,
    leftJoin: () => self,
    where: () => self,
    groupBy: () => Promise.resolve(rows),
    orderBy: () => Promise.resolve(rows),
    limit: () => Promise.resolve(rows),
    then: (res: any) => Promise.resolve(rows).then(res),
  };
  return self;
}

/** Named by the object identity Drizzle would pass, so asserts can tell them apart. */
const tx = {
  select: () => chain(selectResults[selectCall++] ?? []),
  insert: (table: any) => ({
    values: (values: any) => {
      inserted.push({ table: table?.__name ?? 'unknown', values });
      const self: any = {
        returning: () => Promise.resolve([{ id: 'cat-new' }]),
        then: (res: any) => Promise.resolve([{ id: 'cat-new' }]).then(res),
      };
      return self;
    },
  }),
  update: () => ({ set: (v: any) => ({ where: () => { updated.push(v); return Promise.resolve(); } }) }),
};

vi.mock('@/lib/db', () => ({
  db: {
    ...tx,
    transaction: (fn: any) => fn(tx),
  },
}));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => (
    role ? { id: 'admin-1', tenantId: 't1', role } : null
  )),
}));

vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { GET, POST, PATCH } = await import('@/app/api/admin/document-categories/route');

const post = (body: Record<string, unknown>) => POST(new Request(
  'http://localhost/api/admin/document-categories',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
));

const patch = (body: Record<string, unknown>) => PATCH(new Request(
  'http://localhost/api/admin/document-categories',
  { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
));

/** The module's existing rows, as POST reads them first. */
const siblings = (...keys: string[]) => keys.map((documentKey, i) => ({
  documentKey,
  moduleNo: 4,
  moduleName: 'Property & Legal',
  sortOrder: 4000 + i,
  isActive: true,
}));

beforeEach(() => {
  selectCall = 0;
  selectResults = [];
  inserted.length = 0;
  updated.length = 0;
  role = 'SUPER_ADMIN';
});

describe('the platform gate', () => {
  it('refuses every role but SUPER_ADMIN, on every verb', async () => {
    for (const r of ['TENANT_ADMIN', 'STANDARD', '']) {
      role = r;
      expect((await GET(new Request('http://localhost/api/admin/document-categories'))).status)
        .toBe(403);
      expect((await post({ moduleKey: 'property_legal', documentName: 'X' })).status).toBe(403);
      expect((await patch({
        moduleKey: 'property_legal', documentKey: 'will_nomination', documentName: 'X',
      })).status).toBe(403);
    }
  });
});

describe('POST — adding a document type', () => {
  it('derives the key from the label and never takes one from the caller', async () => {
    selectResults = [siblings('will_nomination')];
    const res = await post({
      moduleKey: 'property_legal',
      documentName: 'Gift Deed',
      // Ignored: it is not in the schema at all. A caller who could set it could
      // point a new category at an existing category's Drive folder.
      documentKey: 'pan_card',
    });
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.documentKey).toBe('gift_deed');
  });

  it('uniquifies against a RETIRED sibling, so a tombstone key is never reused', async () => {
    // The route reads every row of the module, inactive ones included.
    selectResults = [[
      ...siblings('will_nomination'),
      { documentKey: 'gift_deed', moduleNo: 4, moduleName: 'Property & Legal', sortOrder: 4090, isActive: false },
    ]];
    const body = await (await post({ moduleKey: 'property_legal', documentName: 'Gift Deed' })).json();

    expect(body.documentKey).toBe('gift_deed_2');
  });

  it('writes the baseline field spec in the same transaction as the row', async () => {
    selectResults = [siblings('will_nomination')];
    await post({ moduleKey: 'property_legal', documentName: 'Gift Deed' });

    // Two inserts: the category, then its fields. A category with no field spec
    // falls back to a dictionary that never declared it — no `document_title`,
    // so its add form is empty and every save is refused.
    expect(inserted).toHaveLength(2);
    const spec = inserted[1].values;
    expect(spec.mandatoryFields).toContain('document_title');
    expect(spec.allFields.split(',')).toEqual(
      expect.arrayContaining(['document_title', 'holder_name', 'notes', 'custom_fields']),
    );
    // `notes` is baseline-sealed for every category; `custom_fields` is
    // baseline-open and must never come back sealed.
    expect(spec.encryptedFields.split(',')).toContain('notes');
    expect(spec.encryptedFields.split(',')).not.toContain('custom_fields');
  });

  it('marks it as added here, not as shipped', async () => {
    selectResults = [siblings('will_nomination')];
    await post({ moduleKey: 'property_legal', documentName: 'Gift Deed' });

    // `is_system` is what tells the screen where a category came from, and what
    // the seed scripts overwrite. A row claiming to be shipped would be rewritten
    // by the next seed run.
    expect(inserted[0].values).toMatchObject({ isSystem: false, isActive: true });
  });

  it('inherits the module\'s number and name from its siblings', async () => {
    selectResults = [siblings('will_nomination')];
    await post({ moduleKey: 'property_legal', documentName: 'Gift Deed' });

    // Asked of the table, never of the caller: a row that disagreed with its
    // siblings would sort itself out of its own module.
    expect(inserted[0].values).toMatchObject({ moduleNo: 4, moduleName: 'Property & Legal' });
  });

  it('appends it after everything in the module', async () => {
    selectResults = [siblings('a', 'b', 'c')];
    await post({ moduleKey: 'property_legal', documentName: 'Gift Deed' });
    expect(inserted[0].values.sortOrder).toBe(4002 + 10);
  });

  it('404s a module that does not exist', async () => {
    selectResults = [[]];
    const res = await post({ moduleKey: 'not_a_module', documentName: 'Gift Deed' });
    expect(res.status).toBe(404);
  });

  it('refuses a module whose every row is retired', async () => {
    selectResults = [[{
      documentKey: 'x', moduleNo: 4, moduleName: 'P', sortOrder: 1, isActive: false,
    }]];
    const res = await post({ moduleKey: 'property_legal', documentName: 'Gift Deed' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/retired/i);
  });

  it('refuses a name the AI masker would rewrite', async () => {
    selectResults = [siblings('will_nomination')];
    const res = await post({
      moduleKey: 'property_legal', documentName: 'Deeds for billing@acme.com',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/personal data|masked|reword/i);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a name with nothing to build a key from', async () => {
    selectResults = [siblings('will_nomination')];
    const res = await post({ moduleKey: 'property_legal', documentName: '???' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/letters or numbers/i);
  });
});

describe('PATCH — renaming, retiring, restoring', () => {
  /** The addressed row, then the count of active rows in its module. */
  const found = (over: any = {}) => [
    [{ id: 'cat-1', documentName: 'Will / nomination documents', isActive: true, ...over }],
  ];

  it('renames a shipped category — labels are display-only', async () => {
    selectResults = [...found(), [{ active: 4 }]];
    const res = await patch({
      moduleKey: 'property_legal', documentKey: 'will_nomination', documentName: 'Wills',
    });

    expect(res.status).toBe(200);
    expect(updated[0]).toMatchObject({ documentName: 'Wills' });
  });

  it('has no way to change a key', async () => {
    selectResults = [...found(), [{ active: 4 }]];
    await patch({
      moduleKey: 'property_legal',
      documentKey: 'will_nomination',
      documentName: 'Wills',
      // Not in the schema. Zod strips it; nothing downstream can see it.
      newDocumentKey: 'wills',
    });

    for (const set of updated) {
      expect(set.documentKey).toBeUndefined();
      expect(set.moduleKey).toBeUndefined();
    }
  });

  it('cannot flip is_system', async () => {
    selectResults = [...found(), [{ active: 4 }]];
    await patch({
      moduleKey: 'property_legal', documentKey: 'will_nomination', isActive: false, isSystem: true,
    });
    for (const set of updated) expect(set.isSystem).toBeUndefined();
  });

  it('retires by deactivating, never by deleting', async () => {
    selectResults = [...found(), [{ active: 4 }]];
    await patch({ moduleKey: 'property_legal', documentKey: 'will_nomination', isActive: false });
    expect(updated[0]).toMatchObject({ isActive: false });
  });

  it('refuses to retire the last active category of a module', async () => {
    // It would take the whole module out of every tenant's navigation, and there
    // is no "restore module" to undo that with.
    selectResults = [...found(), [{ active: 1 }]];
    const res = await patch({
      moduleKey: 'property_legal', documentKey: 'will_nomination', isActive: false,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last active/i);
    expect(updated).toHaveLength(0);
  });

  it('renames a module across every one of its rows', async () => {
    selectResults = [...found(), [{ active: 4 }]];
    await patch({
      moduleKey: 'property_legal', documentKey: 'will_nomination', moduleName: 'Property',
    });

    // The module name is denormalised onto every row. Updating only the
    // addressed one would leave a module whose name depends on which
    // sub-category you looked at.
    expect(updated.some((u) => u.moduleName === 'Property')).toBe(true);
  });

  it('404s a category that does not exist', async () => {
    selectResults = [[]];
    const res = await patch({
      moduleKey: 'property_legal', documentKey: 'nope', documentName: 'X',
    });
    expect(res.status).toBe(404);
  });

  it('refuses a patch that changes nothing', async () => {
    const res = await patch({ moduleKey: 'property_legal', documentKey: 'will_nomination' });
    expect(res.status).toBe(400);
  });
});
