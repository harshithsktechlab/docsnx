/**
 * Guards on the decrypted-store cache.
 *
 * The cache holds tenant PLAINTEXT in process memory, so its correctness is a
 * security property, not a performance one. Two things must hold absolutely: a
 * tenant can never be served another tenant's store, and a store that has moved
 * on must never be served as current.
 *
 * Pure — no DB, no Drive. The revision the cache compares against is supplied by
 * the caller (in production, straight from the `vault_json_files` row read
 * moments earlier), so the whole staleness contract is testable in isolation.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getCachedStore,
  putCachedStore,
  invalidateStore,
  flushTenant,
  flushAll,
  storeCacheStats,
  resetStoreCacheStats,
} from '@/lib/vault/storeCache';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const KEY = { moduleKey: 'identity', documentKey: 'pan_card' };
/** Two companies inside ONE tenant — the business account's isolation axis. */
const COMPANY_X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BIZ_KEY = { moduleKey: 'biz_tax', documentKey: 'gst_returns' };
const OTHER_KEY = { moduleKey: 'identity', documentKey: 'aadhaar_card' };

const store = (id: string, extra: Record<string, unknown> = {}) => ({
  schema: 'docsnx.vault.documents/1',
  revision: 1,
  records: { [id]: { id, title: 'PAN Card', ...extra } },
});

beforeEach(() => {
  flushAll();
  resetStoreCacheStats();
});
afterEach(() => {
  vi.useRealTimers();
  flushAll();
});

describe('hits and misses', () => {
  it('returns nothing for a category it has never seen', () => {
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 1)).toBeNull();
    expect(storeCacheStats().misses).toBe(1);
  });

  it('serves a stored entry when the pointer revision still matches', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 7, store('doc-1'));
    const hit = getCachedStore<any>(TENANT_A, null, 'documents', KEY, 7);
    expect(hit?.records['doc-1'].title).toBe('PAN Card');
    expect(storeCacheStats().hits).toBe(1);
  });

  it('never serves an entry when no pointer row exists', () => {
    // A null pointer means the store has never been written; serving a cached
    // copy then would resurrect a store the database says is gone.
    putCachedStore(TENANT_A, null, 'documents', KEY, 7, store('doc-1'));
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, null)).toBeNull();
  });
});

describe('staleness', () => {
  it('refetches when the pointer revision has moved on', () => {
    // THE correctness contract: another process wrote the store, so its pointer
    // revision advanced. The cached copy is now history and must not be served.
    putCachedStore(TENANT_A, null, 'documents', KEY, 7, store('doc-1'));
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 8)).toBeNull();
    expect(storeCacheStats().staleRefetches).toBe(1);
  });

  it('drops the stale entry rather than keeping it around', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 7, store('doc-1'));
    getCachedStore(TENANT_A, null, 'documents', KEY, 8);
    // Even asking with the ORIGINAL revision must now miss — the entry is gone,
    // not merely bypassed.
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 7)).toBeNull();
    expect(storeCacheStats().entries).toBe(0);
  });

  it('serves the new copy after a write-through', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 7, store('doc-1'));
    putCachedStore(TENANT_A, null, 'documents', KEY, 8, store('doc-1', { title: 'Renamed' }));
    const hit = getCachedStore<any>(TENANT_A, null, 'documents', KEY, 8);
    expect(hit?.records['doc-1'].title).toBe('Renamed');
    expect(storeCacheStats().entries).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('never serves one tenant the other tenant store', () => {
    // Same module, same category, same revision — everything matches except the
    // tenant. This is the leak the cache key exists to prevent.
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-a', { title: 'A secret' }));
    putCachedStore(TENANT_B, null, 'documents', KEY, 1, store('doc-b', { title: 'B secret' }));

    const a = getCachedStore<any>(TENANT_A, null, 'documents', KEY, 1);
    const b = getCachedStore<any>(TENANT_B, null, 'documents', KEY, 1);

    expect(a.records['doc-a'].title).toBe('A secret');
    expect(a.records['doc-b']).toBeUndefined();
    expect(b.records['doc-b'].title).toBe('B secret');
    expect(b.records['doc-a']).toBeUndefined();
  });

  it('keeps tenants in separate entries rather than overwriting', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-a'));
    putCachedStore(TENANT_B, null, 'documents', KEY, 1, store('doc-b'));
    expect(storeCacheStats().entries).toBe(2);
  });

  it('never serves one company the other company store', () => {
    // The same leak one level down, and the one RLS cannot catch: both rows
    // belong to the same tenant, so `app.tenant_id` is identical and the
    // database would happily return either. The cache key is the only thing
    // keeping these apart in this process.
    putCachedStore(TENANT_A, COMPANY_X, 'biz_tax', BIZ_KEY, 1, store('doc-x', { title: 'X returns' }));
    putCachedStore(TENANT_A, COMPANY_Y, 'biz_tax', BIZ_KEY, 1, store('doc-y', { title: 'Y returns' }));

    const x = getCachedStore<any>(TENANT_A, COMPANY_X, 'biz_tax', BIZ_KEY, 1);
    const y = getCachedStore<any>(TENANT_A, COMPANY_Y, 'biz_tax', BIZ_KEY, 1);

    expect(x.records['doc-x'].title).toBe('X returns');
    expect(x.records['doc-y']).toBeUndefined();
    expect(y.records['doc-y'].title).toBe('Y returns');
    expect(y.records['doc-x']).toBeUndefined();
    expect(storeCacheStats().entries).toBe(2);
  });

  it('never serves a company store to the personal vault, or the reverse', () => {
    // The null/undefined boundary specifically: `companyId ?? null` on both the
    // write and the re-assert is what stops "personal" and "company X" from
    // collapsing onto one key.
    putCachedStore(TENANT_A, null, 'biz_tax', BIZ_KEY, 1, store('doc-personal'));
    expect(getCachedStore(TENANT_A, COMPANY_X, 'biz_tax', BIZ_KEY, 1)).toBeNull();

    putCachedStore(TENANT_A, COMPANY_X, 'biz_tax', BIZ_KEY, 1, store('doc-x'));
    const personal = getCachedStore<any>(TENANT_A, null, 'biz_tax', BIZ_KEY, 1);
    expect(personal.records['doc-personal']).toBeDefined();
    expect(personal.records['doc-x']).toBeUndefined();
  });

  it('treats undefined and null as the same personal vault', () => {
    // Callers reach this from `ctx.companyId`, which is optional — so a store
    // written with `undefined` must be found with `null`. If these ever diverge
    // the personal vault silently caches nothing.
    putCachedStore(TENANT_A, undefined, 'documents', KEY, 1, store('doc-a'));
    expect(getCachedStore<any>(TENANT_A, null, 'documents', KEY, 1)?.records['doc-a'])
      .toBeDefined();
    expect(storeCacheStats().entries).toBe(1);
  });

  it('cannot be confused by a module name that splices the key separator', () => {
    // The key is NUL-joined precisely so no component can forge another key by
    // shifting where the boundaries fall.
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('real'));
    const spliced = 'documents\u0000' + KEY.moduleKey;
    expect(
      getCachedStore(TENANT_A, null, spliced, { moduleKey: '', documentKey: KEY.documentKey }, 1),
    ).toBeNull();
  });

  it('flushes exactly one tenant', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-a'));
    putCachedStore(TENANT_A, null, 'documents', OTHER_KEY, 1, store('doc-a2'));
    putCachedStore(TENANT_B, null, 'documents', KEY, 1, store('doc-b'));

    expect(flushTenant(TENANT_A)).toBe(2);
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 1)).toBeNull();
    expect(getCachedStore(TENANT_B, null, 'documents', KEY, 1)).not.toBeNull();
  });
});

describe('isolation from callers', () => {
  it('hands out a copy, so a caller mutating it cannot poison the cache', () => {
    // upsertRecord mutates the store it reads. Without cloning, one request's
    // half-finished edit would become every other request's view.
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-1'));

    const first = getCachedStore<any>(TENANT_A, null, 'documents', KEY, 1);
    first.records['doc-1'].title = 'MUTATED';
    first.records['injected'] = { id: 'injected' };

    const second = getCachedStore<any>(TENANT_A, null, 'documents', KEY, 1);
    expect(second.records['doc-1'].title).toBe('PAN Card');
    expect(second.records['injected']).toBeUndefined();
  });

  it('copies on the way in too, so a later mutation of the source is not seen', () => {
    const source = store('doc-1');
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, source);
    (source.records['doc-1'] as any).title = 'MUTATED AFTER PUT';

    const hit = getCachedStore<any>(TENANT_A, null, 'documents', KEY, 1);
    expect(hit.records['doc-1'].title).toBe('PAN Card');
  });
});

describe('eviction', () => {
  it('expires an entry once the idle window passes', () => {
    vi.useFakeTimers();
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-1'));
    vi.advanceTimersByTime(storeCacheStats().ttlMs + 1000);

    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 1)).toBeNull();
    expect(storeCacheStats().expirations).toBeGreaterThan(0);
  });

  it('slides the window on every read, so an active store stays warm', () => {
    vi.useFakeTimers();
    const ttl = storeCacheStats().ttlMs;
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-1'));

    // Three-quarters of the way through, twice over: total elapsed exceeds the
    // TTL, but the entry was touched in between, so it survives.
    vi.advanceTimersByTime(ttl * 0.75);
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 1)).not.toBeNull();
    vi.advanceTimersByTime(ttl * 0.75);
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 1)).not.toBeNull();
  });

  it('invalidates a single category on request', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-1'));
    putCachedStore(TENANT_A, null, 'documents', OTHER_KEY, 1, store('doc-2'));
    invalidateStore(TENANT_A, null, 'documents', KEY);
    expect(getCachedStore(TENANT_A, null, 'documents', KEY, 1)).toBeNull();
    expect(getCachedStore(TENANT_A, null, 'documents', OTHER_KEY, 1)).not.toBeNull();
  });

  it('keeps total retained bytes bounded', () => {
    const { maxBytes } = storeCacheStats();
    const big = { schema: 's', revision: 1, records: { x: { id: 'x', blob: 'y'.repeat(200_000) } } };
    for (let i = 0; i < 40; i++) {
      putCachedStore(TENANT_A, null, 'identity', { moduleKey: 'identity', documentKey: `k${i}` }, 1, big);
    }
    expect(storeCacheStats().bytes).toBeLessThanOrEqual(maxBytes);
  });

  it('accounts bytes correctly when an entry is replaced', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-1', { blob: 'z'.repeat(5000) }));
    const afterBig = storeCacheStats().bytes;
    putCachedStore(TENANT_A, null, 'documents', KEY, 2, store('doc-1'));
    const afterSmall = storeCacheStats().bytes;

    // A replace must not double-count: the old size has to come back off the
    // total, or the cache slowly starves itself of budget.
    expect(afterSmall).toBeLessThan(afterBig);
    expect(storeCacheStats().entries).toBe(1);
  });

  it('drops to zero bytes when emptied', () => {
    putCachedStore(TENANT_A, null, 'documents', KEY, 1, store('doc-1'));
    putCachedStore(TENANT_B, null, 'documents', KEY, 1, store('doc-2'));
    flushAll();
    expect(storeCacheStats().entries).toBe(0);
    expect(storeCacheStats().bytes).toBe(0);
  });
});
