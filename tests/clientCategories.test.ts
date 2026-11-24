import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_CATEGORY_SEED,
  CLIENT_COMPANY_MODULE,
  CLIENT_INDIVIDUAL_MODULE,
  clientTypeOfModule,
  deriveClientRows,
  fromClientKey,
  isClientCatchAll,
  isClientModule,
  sourceKeyOf,
  toClientKey,
} from '@/lib/clientCategories';
import { DOCUMENT_CATEGORY_SEED, isBusinessModule, isCatchAll } from '@/lib/documentCategories';
import { isMirrorAlias } from '@/lib/categoryMirrors';
import { isSafeCategoryKey, isVaultModule, MODULE_FOLDER } from '@/lib/vault/vaultNaming';
import { RECORD_SCOPES, homeScopeForModule } from '@/lib/records/registry';
import { fieldsFor, encryptedFieldsFor } from '@/lib/documentCategoryFields';

describe('client category keys', () => {
  it('round-trips every source pair through the derived key', () => {
    for (const row of CLIENT_CATEGORY_SEED) {
      const key = { moduleKey: row.moduleKey, documentKey: row.documentKey };
      expect(fromClientKey(key)).toEqual(row.source);
      expect(toClientKey(row.clientType, row.source)).toEqual(key);
    }
  });

  it('no seeded key contains the separator, so the first hyphen is always the join', () => {
    for (const row of DOCUMENT_CATEGORY_SEED) {
      expect(row.moduleKey).not.toContain('-');
      expect(row.documentKey).not.toContain('-');
    }
  });

  it('every derived key is a safe Drive path part and fits the 60-char columns', () => {
    for (const row of CLIENT_CATEGORY_SEED) {
      expect(isSafeCategoryKey({ moduleKey: row.moduleKey, documentKey: row.documentKey })).toBe(true);
      expect(row.documentKey.length).toBeLessThanOrEqual(60);
    }
  });

  it('individual clients derive from personal pairs only and company clients from business only', () => {
    for (const row of CLIENT_CATEGORY_SEED) {
      if (row.clientType === 'individual') {
        expect(row.moduleKey).toBe(CLIENT_INDIVIDUAL_MODULE);
        expect(isBusinessModule(row.source.moduleKey)).toBe(false);
      } else {
        expect(row.moduleKey).toBe(CLIENT_COMPANY_MODULE);
        expect(isBusinessModule(row.source.moduleKey)).toBe(true);
      }
      // The one catch-all row per type is the only row whose source is a catch-all.
      if (row.documentKey !== 'uncategorized') expect(isCatchAll(row.source)).toBe(false);
      expect(isMirrorAlias(row.source)).toBe(false);
      expect(isClientModule(row.source.moduleKey)).toBe(false);
    }
  });

  it('is biz-prefixed, so the workspace / company rules apply unchanged', () => {
    expect(isBusinessModule(CLIENT_INDIVIDUAL_MODULE)).toBe(true);
    expect(isBusinessModule(CLIENT_COMPANY_MODULE)).toBe(true);
    expect(clientTypeOfModule(CLIENT_COMPANY_MODULE)).toBe('company');
    expect(clientTypeOfModule('biz_tax')).toBeNull();
  });

  it('sourceKeyOf is the identity for anything that is not a client category', () => {
    const k = { moduleKey: 'identity', documentKey: 'pan_card' };
    expect(sourceKeyOf(k)).toBe(k);
    expect(sourceKeyOf({ moduleKey: CLIENT_INDIVIDUAL_MODULE, documentKey: 'identity-pan_card' })).toEqual(k);
    expect(fromClientKey({ moduleKey: CLIENT_INDIVIDUAL_MODULE, documentKey: 'nohyphen' })).toBeNull();
  });

  it('each client module has exactly one catch-all, last, resolving to its taxonomy catch-all', () => {
    for (const [type, mod, src] of [
      ['individual', CLIENT_INDIVIDUAL_MODULE, 'other/uncategorized'],
      ['company', CLIENT_COMPANY_MODULE, 'biz_other/uncategorized'],
    ] as const) {
      const rows = CLIENT_CATEGORY_SEED.filter((r) => r.clientType === type);
      expect(rows.filter((r) => r.documentKey === 'uncategorized')).toHaveLength(1);
      expect(rows[rows.length - 1].documentKey).toBe('uncategorized');
      const key = { moduleKey: mod, documentKey: 'uncategorized' };
      expect(isClientCatchAll(key)).toBe(true);
      const from = fromClientKey(key)!;
      expect(`${from.moduleKey}/${from.documentKey}`).toBe(src);
    }
  });

  it('derives sort orders that keep the source order within each client module', () => {
    for (const type of ['individual', 'company'] as const) {
      const rows = CLIENT_CATEGORY_SEED.filter((r) => r.clientType === type);
      const orders = rows.map((r) => r.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    }
  });

  it('deriveClientRows only needs the three source columns', () => {
    const rows = deriveClientRows([{ moduleKey: 'identity', documentKey: 'pan_card', documentName: 'PAN Card' }]);
    // One personal source → one individual row; each type then adds its catch-all.
    expect(rows.map((r) => `${r.moduleKey}/${r.documentKey}`)).toEqual([
      'biz_client_individual/identity-pan_card',
      'biz_client_individual/uncategorized',
      'biz_client_company/uncategorized',
    ]);
  });
});

describe('client modules are wired into the vault and record registries', () => {
  it('are vault modules with a JSON folder', () => {
    for (const m of [CLIENT_INDIVIDUAL_MODULE, CLIENT_COMPANY_MODULE]) {
      expect(isVaultModule(m)).toBe(true);
      expect(MODULE_FOLDER[m as keyof typeof MODULE_FOLDER]).toBeTruthy();
    }
  });

  it('each has a record scope of its own that homes the module', () => {
    for (const m of [CLIENT_INDIVIDUAL_MODULE, CLIENT_COMPANY_MODULE]) {
      expect(RECORD_SCOPES[m]).toBeDefined();
      expect(homeScopeForModule(m)).toBe(m);
    }
  });

  it('a client category takes its form and sealing from the source category', () => {
    const src = { moduleKey: 'identity', documentKey: 'pan_card' };
    const key = toClientKey('individual', src);
    expect(fieldsFor(key)).toBe(fieldsFor(src));
    expect(encryptedFieldsFor(key)).toEqual(encryptedFieldsFor(src));
    expect(fieldsFor(key).length).toBeGreaterThan(0);
  });
});

describe('drizzle/0098 parity', () => {
  const sql = readFileSync(join(__dirname, '../drizzle/0098_client_document_categories.sql'), 'utf8');

  it('seeds exactly the rows CLIENT_CATEGORY_SEED derives', () => {
    const tuples = [...sql.matchAll(/\((11[78]),'([^']+)','[^']*','([^']+)','[^']*',(\d+)\)/g)];
    expect(tuples).toHaveLength(CLIENT_CATEGORY_SEED.length);
    const byKey = new Map(CLIENT_CATEGORY_SEED.map((r) => [`${r.moduleKey}/${r.documentKey}`, r]));
    for (const [, no, moduleKey, documentKey, sort] of tuples) {
      const row = byKey.get(`${moduleKey}/${documentKey}`);
      expect(row, `${moduleKey}/${documentKey}`).toBeDefined();
      expect(row!.moduleNo).toBe(Number(no));
      expect(row!.sortOrder).toBe(Number(sort));
    }
  });
});

describe('categoryDisplay for a client category', () => {
  it('names a derived category for the source it derives from', async () => {
    const { categoryDisplay } = await import('@/lib/documentCategories');
    expect(categoryDisplay({ moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' }))
      .toMatchObject({ documentName: 'PAN Card', moduleName: 'Client Documents — Individual', moduleNo: 117 });
    expect(categoryDisplay({ moduleKey: 'biz_client_company', documentKey: 'uncategorized' }))
      .toMatchObject({ documentName: 'Others', moduleNo: 118 });
    expect(categoryDisplay({ moduleKey: 'biz_client_company', documentKey: 'nohyphen' })).toBeUndefined();
  });
});
