import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DOCUMENT_CATEGORY_SEED } from '@/lib/documentCategories';
import { CLIENT_CATEGORY_SEED } from '@/lib/clientCategories';

/**
 * A fake `document_categories` table behind the same three drizzle calls
 * `syncClientCategories` makes (select … orderBy, insert … onConflictDoNothing,
 * update … set … where). The rule under test is the RECONCILIATION, not SQL.
 */
type Row = {
  moduleKey: string; documentKey: string; documentName: string; isActive: boolean;
  isSystem: boolean; moduleNo: number; moduleName?: string; sortOrder: number;
};
let table: Row[] = [];
const updates: { moduleKey: string; documentKey: string; set: any }[] = [];

vi.mock('@/lib/taxonomyRegistry', () => ({ invalidateTaxonomy: vi.fn() }));
vi.mock('@/db/schema', () => ({
  documentCategories: new Proxy({}, { get: (_t, p) => ({ __col: String(p) }) }),
}));
vi.mock('drizzle-orm', () => ({
  and: (...a: any[]) => ({ and: a }),
  eq: (c: any, v: any) => ({ col: c.__col, v }),
}));
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ orderBy: async () => table.map((r) => ({ ...r })) }) }),
    insert: () => ({
      values: (rows: any[]) => ({
        onConflictDoNothing: async () => { for (const r of rows) table.push({ ...r }); },
      }),
    }),
    update: () => ({
      set: (set: any) => ({
        where: async (w: any) => {
          const conds = w.and as { col: string; v: string }[];
          const moduleKey = conds.find((c) => c.col === 'moduleKey')!.v;
          const documentKey = conds.find((c) => c.col === 'documentKey')!.v;
          updates.push({ moduleKey, documentKey, set });
          const row = table.find((r) => r.moduleKey === moduleKey && r.documentKey === documentKey)!;
          Object.assign(row, set);
        },
      }),
    }),
  },
}));

import { syncClientCategories } from '@/lib/clients/syncClientCategories';

const seedAsTable = (): Row[] => [
  ...DOCUMENT_CATEGORY_SEED.map((r) => ({ ...r, isActive: true, isSystem: true })),
  ...CLIENT_CATEGORY_SEED.map((r) => ({ ...r, isActive: true, isSystem: true })),
];

describe('syncClientCategories', () => {
  beforeEach(() => { table = seedAsTable(); updates.length = 0; });

  it('is a no-op on a database that migration 0098 already seeded', async () => {
    const r = await syncClientCategories();
    expect(r).toEqual({ inserted: 0, updated: 0, retired: 0, restored: 0 });
    expect(updates).toHaveLength(0);
  });

  it('derives a row for a subcategory an operator adds, for the right client type', async () => {
    table.push({
      moduleKey: 'identity', documentKey: 'abha_card', documentName: 'ABHA card',
      isActive: true, isSystem: false, moduleNo: 1, sortOrder: 1090,
    });
    const r = await syncClientCategories();
    expect(r.inserted).toBe(1);
    const added = table.find((x) => x.documentKey === 'identity-abha_card')!;
    expect(added.moduleKey).toBe('biz_client_individual');
    expect(added.isSystem).toBe(false);
    expect(added.documentName).toBe('ABHA card');
  });

  it('retires, never deletes, a derived row when its source is retired — and restores it', async () => {
    const src = table.find((x) => x.moduleKey === 'identity' && x.documentKey === 'passport')!;
    src.isActive = false;
    const before = table.length;
    const retired = await syncClientCategories();
    expect(retired.retired).toBe(1);
    expect(table.length).toBe(before);
    expect(table.find((x) => x.documentKey === 'identity-passport')!.isActive).toBe(false);

    src.isActive = true;
    const restored = await syncClientCategories();
    expect(restored.restored).toBe(1);
    expect(table.find((x) => x.documentKey === 'identity-passport')!.isActive).toBe(true);
  });

  it('follows a rename of the source', async () => {
    table.find((x) => x.moduleKey === 'identity' && x.documentKey === 'pan_card')!.documentName = 'PAN';
    await syncClientCategories();
    expect(table.find((x) => x.documentKey === 'identity-pan_card')!.documentName).toBe('PAN');
  });

  it('does not mint derived rows for already-retired source rows', async () => {
    table.push({
      moduleKey: 'identity', documentKey: 'miscellaneous', documentName: 'Misc',
      isActive: false, isSystem: true, moduleNo: 1, sortOrder: 1999,
    });
    const r = await syncClientCategories();
    expect(r.inserted).toBe(0);
    expect(table.some((x) => x.documentKey === 'identity-miscellaneous')).toBe(false);
  });
});
