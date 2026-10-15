/**
 * Global search matches a query TERM BY TERM — natural phrases, members,
 * categories, dates, and the hashed keyword index (sealed fields and the
 * document's own text).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docRows: any[] = [];
const memberRows: any[] = [];
const holderRows: any[] = [];
let stores: Record<string, any> = {};
const tableRows = new Map<any, any[]>();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', tenant: { id: 't1' }, role: 'STANDARD',
  })),
  hasPermission: vi.fn(async () => true),
  hasCompanyAccess: vi.fn(async () => true),
  hasPersonalAccess: vi.fn(() => true),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: vi.fn(async () => ({ store: { records: stores } })),
}));
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({
      from: (table: any) => ({
        leftJoin: () => ({ where: async () => docRows }),
        where: async () => tableRows.get(table) ?? [],
      }),
    }),
  })),
}));
vi.mock('@/lib/taxonomyRegistry', () => ({
  activeCategoryKeys: vi.fn(async () => [
    { moduleKey: 'bank_investments', documentKey: 'bank_statements' },
    { moduleKey: 'identity', documentKey: 'passport' },
    { moduleKey: 'utilities', documentKey: 'electricity' },
  ]),
  moduleNames: vi.fn(async () => new Map([
    ['bank_investments', 'Bank & Investments'],
    ['identity', 'Identity'],
    ['utilities', 'Utility Bills'],
  ])),
}));

const { users, documentHolders, passwords } = await import('@/db/schema');
const { fieldTokens, hashSearchTokens, textTokens } = await import('@/lib/search/tokens');
const { GET } = await import('@/app/api/search/route');

const row = (over: Record<string, unknown>) => ({
  id: 'd', title: 'Untitled', module: 'bank_investments', documentKey: 'bank_statements',
  categoryName: 'Bank Statements', moduleName: 'Bank & Investments', customSubcategory: null,
  fileName: null, companyId: null, holderId: null, isGlobal: false,
  createdAt: new Date('2025-09-01T10:00:00Z'),
  ...over,
});

const titles = async (q: string) => {
  const res = await GET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`) as any);
  const json = await res.json();
  return json.results.map((r: any) => r.title);
};

beforeEach(() => {
  docRows.length = 0;
  memberRows.length = 0;
  holderRows.length = 0;
  stores = {};
  tableRows.clear();
  tableRows.set(users, memberRows);
  tableRows.set(documentHolders, holderRows);
  tableRows.set(passwords, []);
});

describe('search matching', () => {
  it('reads "April month bank statement" as a month plus words, in any order', async () => {
    docRows.push(row({ id: 'apr', title: 'HDFC savings' }), row({ id: 'mar', title: 'ICICI savings' }));
    stores = {
      apr: { open: { statement_date: '2025-04-30' } },
      mar: { open: { statement_date: '2025-03-31' } },
    };
    expect(await titles('April month bank statement')).toEqual(['HDFC savings']);
  });

  it('finds a written day and month — "15th may"', async () => {
    docRows.push(row({ id: 'a', title: 'Receipt A' }), row({ id: 'b', title: 'Receipt B' }));
    stores = { a: { open: { issue_date: '15/05/2025' } }, b: { open: { issue_date: '16/05/2025' } } };
    expect(await titles('15th may')).toEqual(['Receipt A']);
  });

  it('finds a record by the member it belongs to', async () => {
    memberRows.push({ id: 'm1', name: 'Priya Sharma' }, { id: 'm2', name: 'Ravi Kumar' });
    docRows.push(
      row({ id: 'p1', title: 'Passport', module: 'identity', documentKey: 'passport', categoryName: 'Passport', holderId: 'm1' }),
      row({ id: 'p2', title: 'Passport', module: 'identity', documentKey: 'passport', categoryName: 'Passport', holderId: 'm2' }),
      row({ id: 'p3', title: 'Joint statement', holderId: 'm2' }),
    );
    holderRows.push({ documentId: 'p3', userId: 'm1' });
    const found = await titles('priya');
    expect(found).toHaveLength(2);
    expect(found).toContain('Joint statement');
  });

  it('finds a sealed address and the document text through hashed tokens only', async () => {
    docRows.push(
      row({ id: 'e1', title: 'Power bill', module: 'utilities', documentKey: 'electricity', categoryName: 'Electricity' }),
      row({ id: 'e2', title: 'Other bill', module: 'utilities', documentKey: 'electricity', categoryName: 'Electricity' }),
    );
    stores = {
      e1: {
        open: {},
        searchTokens: hashSearchTokens(fieldTokens('Power bill', { address: '12 Linking Road, Bandra West' })),
        contentTokens: hashSearchTokens(textTokens('Adani Electricity — billing period June 2025')),
      },
      e2: { open: {} },
    };
    expect(await titles('bandra')).toEqual(['Power bill']);
    expect(await titles('adani june electricity bills')).toEqual(['Power bill']);
    // No plaintext of the address was ever in the store.
    expect(JSON.stringify(stores.e1)).not.toMatch(/bandra/i);
  });

  it('falls back to the best partial matches when nothing matches every word', async () => {
    docRows.push(row({ id: 'x', title: 'Savings statement' }));
    stores = { x: { open: {} } };
    expect(await titles('savings statement zzyzx')).toEqual(['Savings statement']);
  });

  it('matches the category and the module by name', async () => {
    docRows.push(row({ id: 'x', title: 'Q1' }));
    stores = { x: { open: {} } };
    expect(await titles('bank investments')).toEqual(['Q1']);
  });
});
