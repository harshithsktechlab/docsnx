/**
 * POST /api/search/track — the search log. Redaction, the keyword -> document
 * upsert, and who may attach a keyword to which document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let docRows: any[] = [];
const inserted: { table: any; values: any; conflict?: any }[] = [];
let allowView = true;

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', tenant: { id: 't1' }, role: 'STANDARD',
  })),
  hasPermission: vi.fn(async () => allowView),
  hasCompanyAccess: vi.fn(async () => true),
  hasPersonalAccess: vi.fn(() => true),
}));
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => docRows }) }) }),
    insert: (table: any) => ({
      values: (values: any) => {
        const entry: { table: any; values: any; conflict?: any } = { table, values };
        inserted.push(entry);
        return {
          onConflictDoUpdate: async (conflict: any) => { entry.conflict = conflict; },
          then: (res: any) => res(undefined),
        };
      },
    }),
  })),
}));

const { searchKeywords } = await import('@/db/schema');
const { POST } = await import('@/app/api/search/track/route');

const DOC = '3f1c0b8e-6a3b-4c43-9a55-0a1b2c3d4e5f';
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/search/track', {
    method: 'POST', body: JSON.stringify(body),
  }) as any);

beforeEach(() => {
  inserted.length = 0;
  allowView = true;
  docRows = [{ id: DOC, title: 'Passport', moduleKey: 'identity', documentKey: 'passport', companyId: null }];
});

describe('search tracking', () => {
  it('records one keyword row per redacted term, with the document it led to', async () => {
    const res = await post({ query: 'Priya passport 50100123456789', outcome: 'clicked', documentId: DOC, resultCount: 3, matchedIn: 'name' });
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    const { table, values, conflict } = inserted[0];
    expect(table).toBe(searchKeywords);
    expect(values.map((v: any) => v.keyword)).toEqual(['priya', 'passport']);
    expect(values[0]).toMatchObject({
      tenantId: 't1', documentId: DOC, documentTitle: 'Passport', categoryKey: 'identity/passport',
      lastResultCount: 3, lastMatchedTier: 'name', lastUserId: 'u1',
    });
    // The long number never reaches the row.
    expect(JSON.stringify(values)).not.toMatch(/5010/);
    // Conflicts on (tenant, keyword, document): a repeat raises hit_count.
    expect(conflict.target).toHaveLength(3);
    expect(conflict.set.hitCount).toBeDefined();
  });

  it('keeps a search that found nothing as keyword rows with no document', async () => {
    const res = await post({ query: 'tax receipt 2019', outcome: 'no_result' });
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    const { values, conflict } = inserted[0];
    expect(values.map((v: any) => v.keyword)).toEqual(['tax', 'receipt', '2019']);
    expect(values.every((v: any) => v.documentId === null && v.documentTitle === null)).toBe(true);
    // Conflicts on (tenant, keyword) among the rows that have no document.
    expect(conflict.target).toHaveLength(2);
  });

  it('logs nothing for an exact identifier lookup', async () => {
    const json = await (await post({ query: 'hdfc', outcome: 'clicked', documentId: DOC, exact: true })).json();
    expect(json.logged).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it('logs nothing when the query is only an identifier', async () => {
    const json = await (await post({ query: 'ABCDE1234F', outcome: 'no_result' })).json();
    expect(json.logged).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a document the caller cannot see or that is not in the tenant', async () => {
    docRows = [];
    expect((await post({ query: 'passport', outcome: 'clicked', documentId: DOC })).status).toBe(404);
    docRows = [{ id: DOC, title: 'Passport', moduleKey: 'identity', documentKey: 'passport', companyId: null }];
    allowView = false;
    expect((await post({ query: 'passport', outcome: 'clicked', documentId: DOC })).status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it('rejects malformed bodies', async () => {
    expect((await post({ query: 'a', outcome: 'clicked', documentId: DOC })).status).toBe(400);
    expect((await post({ query: 'passport', outcome: 'clicked', documentId: 'nope' })).status).toBe(400);
    expect((await post({ query: 'passport', outcome: 'other' })).status).toBe(400);
  });
});
