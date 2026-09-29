/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE LIVE TAXONOMY — the three things it must never get wrong           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `src/lib/taxonomyRegistry.ts` is what every route now asks "is this category
 * real?", replacing a compiled constant that could not be wrong. Three
 * properties carry that swap:
 *
 *  1. It answers for a category an operator CREATED — the whole point.
 *  2. It stops answering for one they RETIRED — most of what retiring means.
 *  3. A failed read falls back to the shipped taxonomy, never to an empty list.
 *     An empty answer would make every category unknown at once: every upload
 *     404s and every list empties, which looks like the app was deleted.
 *
 * Plus the direction of the cache's failure mode, which is the reason a 60s
 * stale window is acceptable at all: it can only ever make the app too STRICT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the fake `db` hands back, and whether it throws instead. */
let rows: any[] = [];
let failWith: Error | null = null;
let reads = 0;

vi.mock('@/lib/db', () => {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => {
      reads += 1;
      return failWith ? Promise.reject(failWith) : Promise.resolve(rows);
    },
  };
  return { db: { select: () => chain } };
});

const SEEDED = { moduleKey: 'identity', documentKey: 'pan_card' };

/** A fresh module instance, so the module-scope cache starts empty each time. */
async function freshRegistry() {
  vi.resetModules();
  return import('@/lib/taxonomyRegistry');
}

const row = (moduleKey: string, documentKey: string, over: any = {}) => ({
  moduleNo: 1,
  moduleKey,
  moduleName: 'Identity',
  documentKey,
  documentName: documentKey,
  sortOrder: 10,
  isSystem: true,
  ...over,
});

beforeEach(() => {
  rows = [row('identity', 'pan_card'), row('identity', 'passport')];
  failWith = null;
  reads = 0;
});

describe('knownCategory', () => {
  it('accepts a category an operator created, which no build knows about', async () => {
    rows.push(row('property_legal', 'gift_deed', { isSystem: false }));
    const reg = await freshRegistry();

    expect(await reg.knownCategory('property_legal', 'gift_deed')).toBe(true);

    // The compiled list is the control: it has never heard of this pair, which
    // is exactly why the runtime question had to stop being asked of it.
    const { isSeededCategory } = await import('@/lib/documentCategories');
    expect(isSeededCategory('property_legal', 'gift_deed')).toBe(false);
  });

  it('refuses a category that was retired', async () => {
    // The route reads only active rows, so a retired one simply is not here.
    rows = [row('identity', 'pan_card')];
    const reg = await freshRegistry();

    expect(await reg.knownCategory('identity', 'pan_card')).toBe(true);
    expect(await reg.knownCategory('identity', 'passport')).toBe(false);
  });

  it('checks the PAIR, not either half', async () => {
    const reg = await freshRegistry();
    // `registration_certificate` is a real key under two different modules, so a
    // check on the document half alone would accept it under any of them.
    expect(await reg.knownCategory('identity', 'gift_deed')).toBe(false);
    expect(await reg.knownCategory('property_legal', 'pan_card')).toBe(false);
  });

  it('refuses anything that is not a pair of strings', async () => {
    const reg = await freshRegistry();
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(await reg.knownCategory(bad, bad)).toBe(false);
      expect(await reg.knownCategory('identity', bad)).toBe(false);
    }
  });
});

describe('when the database cannot be read', () => {
  it('serves the shipped taxonomy rather than an empty one', async () => {
    failWith = new Error('connection refused');
    const reg = await freshRegistry();

    const { DOCUMENT_CATEGORY_SEED } = await import('@/lib/documentCategories');
    expect(await reg.activeCategoryCount()).toBe(DOCUMENT_CATEGORY_SEED.length);
    expect(await reg.knownCategory(SEEDED.moduleKey, SEEDED.documentKey)).toBe(true);
  });

  it('treats an empty table as a failed read, not as "no categories"', async () => {
    // A table answering nothing is a database mid-migration. Believing it would
    // make every category on the platform unknown at once.
    rows = [];
    const reg = await freshRegistry();

    const { DOCUMENT_CATEGORY_SEED } = await import('@/lib/documentCategories');
    expect(await reg.activeCategoryCount()).toBe(DOCUMENT_CATEGORY_SEED.length);
  });

  it('does not poison the cache — the next caller retries', async () => {
    failWith = new Error('connection refused');
    const reg = await freshRegistry();
    await reg.knownCategory('identity', 'pan_card');

    failWith = null;
    rows = [row('property_legal', 'gift_deed', { isSystem: false })];
    // A rejection cached as the answer would keep serving the fallback forever.
    expect(await reg.knownCategory('property_legal', 'gift_deed')).toBe(true);
  });
});

describe('the cache', () => {
  it('reads once for many questions', async () => {
    const reg = await freshRegistry();
    await Promise.all([
      reg.knownCategory('identity', 'pan_card'),
      reg.knownCategory('identity', 'passport'),
      reg.activeCategoryKeys(),
    ]);
    expect(reads).toBe(1);
  });

  it('can only make the app too strict, never too permissive', async () => {
    const reg = await freshRegistry();
    await reg.activeCategoryKeys();

    // A category added elsewhere, not yet visible to this process. A NEW array,
    // not a push: the cache holds a reference to the one it was served, so
    // mutating it in place would be this test lying to itself.
    rows = [...rows, row('property_legal', 'gift_deed', { isSystem: false })];
    expect(await reg.knownCategory('property_legal', 'gift_deed')).toBe(false);

    // A stale cache REFUSES the unknown key. It never accepts a retired one:
    // that direction would be a category still writable after being retired.
    reg.invalidateTaxonomy();
    expect(await reg.knownCategory('property_legal', 'gift_deed')).toBe(true);
  });

  it('is dropped by invalidateTaxonomy, so a creation is visible at once', async () => {
    const reg = await freshRegistry();
    await reg.activeCategoryKeys();
    expect(reads).toBe(1);

    reg.invalidateTaxonomy();
    await reg.activeCategoryKeys();
    expect(reads).toBe(2);
  });
});

describe('the AI prompt', () => {
  it('is rendered by the same function as the compiled one', async () => {
    // Two renderings of this list is how the batch scanner and the single
    // document classifier start disagreeing about where a document goes. Fed
    // the shipped rows, the live path must produce the compiled string exactly.
    const { DOCUMENT_CATEGORY_SEED, buildAiCategoryList } =
      await import('@/lib/documentCategories');
    rows = DOCUMENT_CATEGORY_SEED.map((r) => ({ ...r, isSystem: true }));
    const reg = await freshRegistry();

    expect(await reg.buildLiveAiCategoryList()).toBe(buildAiCategoryList());
  });

  it('offers a category an operator added', async () => {
    rows = [
      row('property_legal', 'gift_deed', {
        moduleNo: 4, moduleName: 'Property & Legal', documentName: 'Gift Deed', isSystem: false,
      }),
    ];
    const reg = await freshRegistry();
    const list = await reg.buildLiveAiCategoryList();

    expect(list).toContain('"gift_deed": Gift Deed');
    expect(list).toContain('(moduleKey: "property_legal")');
  });

  it('always ends with the fallback stanza, whatever the table holds', async () => {
    rows = [row('property_legal', 'gift_deed', { isSystem: false })];
    const reg = await freshRegistry();
    const { UNCATEGORIZED } = await import('@/lib/documentCategories');

    expect(await reg.buildLiveAiCategoryList())
      .toContain(`Fallback (moduleKey: "${UNCATEGORIZED.moduleKey}")`);
  });
});

describe('grouping', () => {
  it('keeps the table\'s own order, which is the information architecture', async () => {
    rows = [
      row('identity', 'pan_card', { moduleNo: 1, sortOrder: 1002 }),
      row('property_legal', 'gift_deed', { moduleNo: 4, moduleName: 'Property & Legal' }),
      row('identity', 'passport', { moduleNo: 1, sortOrder: 1003 }),
    ];
    const reg = await freshRegistry();
    const modules = await reg.taxonomyModules();

    // Grouped by first appearance, never re-sorted: the query already ordered
    // by (module_no, sort_order) and re-sorting here would be a second opinion.
    expect(modules.map((m) => m.moduleKey)).toEqual(['identity', 'property_legal']);
    expect(modules[0].subCategories.map((s) => s.documentKey)).toEqual(['pan_card', 'passport']);
  });

  it('gives display names for a live pair and nothing for an unknown one', async () => {
    rows = [row('property_legal', 'gift_deed', {
      moduleName: 'Property & Legal', documentName: 'Gift Deed', isSystem: false,
    })];
    const reg = await freshRegistry();

    expect(await reg.displayLive({ moduleKey: 'property_legal', documentKey: 'gift_deed' }))
      .toMatchObject({ moduleName: 'Property & Legal', documentName: 'Gift Deed' });
    // Undefined, not the raw keys: `property_legal/gift_deed` is an identity,
    // and a caller rendering it to a user has skipped a lookup.
    expect(await reg.displayLive({ moduleKey: 'identity', documentKey: 'nope' })).toBeUndefined();
  });
});
