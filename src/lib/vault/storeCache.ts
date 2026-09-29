/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DECRYPTED STORE CACHE — the thing that makes Drive-first lists usable  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A record's data lives in the tenant's Google Drive, in one encrypted JSON
 * store per (module, category). `readJsonStore` downloads and AES-GCM-opens an
 * ENTIRE store per call, so without a cache every list page is N Drive round
 * trips — N being the number of categories that module spans.
 *
 * ── HOW STALENESS IS DETECTED ──────────────────────────────────────────────
 * Not by trusting the TTL. Every read first fetches the store's pointer row
 * from `vault_json_files` — one indexed Postgres query — and compares its
 * `revision` with the cached one. A mismatch refetches. That spends a cheap
 * local query to avoid a ~200-600 ms Drive download, and it catches a store
 * mutated by another process, by a restore, or by someone editing the file in
 * Drive's own UI. The TTL is a memory bound, not a correctness mechanism.
 *
 * `readJsonStore` still raises VAULT_STALE_FILE when a downloaded store is
 * BEHIND its pointer. This layer sits above that check and does not replace it.
 *
 * ── WHY ENTRIES ARE CLONED ─────────────────────────────────────────────────
 * `upsertRecord` mutates the store it reads (`store.records[id] = …`). Handing
 * out the cached object directly would let one request's half-finished edit
 * become another request's view of the world. Reads hand back a structured
 * clone; writes prime the cache with a clone of what they sealed.
 *
 * ── CROSS-TENANT SAFETY ────────────────────────────────────────────────────
 * `tenantId` is the first component of the key AND is re-asserted against the
 * entry on every hit. Since the business account, `companyId` is the second and
 * is checked the same way — two companies inside one tenant are as separate as
 * two tenants, and this cache holds their records in the clear. A defect here is a cross-tenant data leak, not a
 * performance bug, so it is checked twice and covered by its own test. There is
 * deliberately no exported "get by key" that omits the tenant.
 *
 * ── WHAT THIS COSTS ────────────────────────────────────────────────────────
 * Decrypted tenant PII sits in this process's memory for up to the TTL. Before
 * it, plaintext existed only for the life of a request. A heap dump or an
 * in-process RCE now exposes recently-viewed records for every active tenant.
 * That is the accepted price of Drive-first storage with usable lists.
 *
 * The cache is PER PROCESS. Production runs a single `next start`, so it is
 * coherent today. A second instance would serve its own view until each entry's
 * revision check caught up — moving this to Redis is the prerequisite for
 * running more than one.
 */
import type { CategoryKey } from '../documentCategories';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../vaultKey';
import type { VaultModule } from './vaultNaming';

/** Sliding idle window, deliberately the same as the client vault's. */
const TTL_MS = Number(process.env.VAULT_STORE_CACHE_TTL_MS) || DEFAULT_IDLE_TIMEOUT_MS;

/**
 * Hard ceiling on retained plaintext. An unbounded Map would grow with every
 * category every tenant touches until the process died.
 */
const MAX_BYTES = Number(process.env.VAULT_STORE_CACHE_MAX_BYTES) || 64 * 1024 * 1024;

/** Escape hatch for debugging a suspected staleness problem. */
const DISABLED = process.env.VAULT_STORE_CACHE_DISABLED === '1';

interface Entry {
  tenantId: string;
  /** null for a personal store. Part of the identity, not a detail. */
  companyId: string | null;
  module: string;
  categoryModuleKey: string;
  categoryDocumentKey: string;
  revision: number;
  /** The decrypted store. Never handed out without cloning. */
  store: unknown;
  /** Approximate retained size, for the byte cap. */
  bytes: number;
  /** Last read or write, for the sliding TTL. */
  touchedAt: number;
}

/**
 * Insertion order IS the LRU order: a hit deletes and re-inserts, so the oldest
 * entry is always the first one `keys()` yields.
 */
const cache = new Map<string, Entry>();
let totalBytes = 0;

const stats = { hits: 0, misses: 0, staleRefetches: 0, evictions: 0, expirations: 0 };

/**
 * NUL-separated because every component is a slug or a UUID — `isSafeKeyPart`
 * restricts category halves to [a-z0-9_-] — so a NUL can never appear inside
 * one. A printable separator would let a crafted module name forge a key that
 * collides with another tenant's.
 */
function cacheKey(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule | string,
  categoryKey: CategoryKey,
): string {
  // The company is the SECOND component, right after the tenant, because it is
  // the second isolation boundary: two companies in one tenant filing into
  // `biz_tax/gst_returns` hold two entirely separate stores, and a key that
  // omitted it would serve one company the other's decrypted records.
  return [tenantId, companyId ?? '', module, categoryKey.moduleKey, categoryKey.documentKey]
    .join('\u0000');
}

function sizeOf(store: unknown): number {
  try {
    return JSON.stringify(store)?.length ?? 0;
  } catch {
    return 0;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function drop(key: string, reason: 'evictions' | 'expirations'): void {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  cache.delete(key);
  stats[reason]++;
}

/** Evicts expired entries, then the least recently used until under the cap. */
function reclaim(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.touchedAt > TTL_MS) drop(key, 'expirations');
  }
  while (totalBytes > MAX_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    drop(oldest.value, 'evictions');
  }
}

/**
 * The cached store for a category, if it is still current.
 *
 * `pointerRevision` is the revision just read from `vault_json_files`; pass
 * `null` when no pointer row exists, which can never be a hit.
 */
export function getCachedStore<S>(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule | string,
  categoryKey: CategoryKey,
  pointerRevision: number | null,
): S | null {
  if (DISABLED || pointerRevision === null) return null;

  const key = cacheKey(tenantId, companyId, module, categoryKey);
  const entry = cache.get(key);
  if (!entry) {
    stats.misses++;
    return null;
  }

  const now = Date.now();
  if (now - entry.touchedAt > TTL_MS) {
    drop(key, 'expirations');
    stats.misses++;
    return null;
  }

  // Belt and braces: the key already begins with the tenant id, so this can
  // only fire on a programming error — which is exactly the error that would
  // otherwise serve one tenant another tenant's records.
  if (entry.tenantId !== tenantId) {
    drop(key, 'evictions');
    stats.misses++;
    return null;
  }

  // The same belt-and-braces check for the company boundary, and for the same
  // reason: a defect here is a cross-COMPANY leak of decrypted records, not a
  // performance bug. `?? null` on both sides so undefined and null — both of
  // which mean "personal" — cannot be made to differ.
  if ((entry.companyId ?? null) !== (companyId ?? null)) {
    drop(key, 'evictions');
    stats.misses++;
    return null;
  }

  if (entry.revision !== pointerRevision) {
    drop(key, 'evictions');
    stats.staleRefetches++;
    stats.misses++;
    return null;
  }

  // Re-insert to move this entry to the MRU end of the iteration order.
  cache.delete(key);
  entry.touchedAt = now;
  cache.set(key, entry);
  stats.hits++;
  return clone(entry.store) as S;
}

/**
 * Record a freshly read or freshly written store.
 *
 * Called by `readJsonStore` after a download and by `upsertRecord` after a
 * successful upload — the latter being a write-through, so a write never leaves
 * a stale entry behind for the next reader to trip over.
 */
export function putCachedStore(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule | string,
  categoryKey: CategoryKey,
  revision: number,
  store: unknown,
): void {
  if (DISABLED) return;

  const key = cacheKey(tenantId, companyId, module, categoryKey);
  const copy = clone(store);
  const bytes = sizeOf(copy);

  // A single store larger than the whole budget would evict everything and then
  // itself; not caching it at all is the honest outcome.
  if (bytes > MAX_BYTES) {
    drop(key, 'evictions');
    return;
  }

  const existing = cache.get(key);
  if (existing) {
    totalBytes -= existing.bytes;
    cache.delete(key);
  }

  cache.set(key, {
    tenantId,
    companyId: companyId ?? null,
    module: String(module),
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    revision,
    store: copy,
    bytes,
    touchedAt: Date.now(),
  });
  totalBytes += bytes;

  reclaim(Date.now());
}

/** Forget one category's store. */
export function invalidateStore(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule | string,
  categoryKey: CategoryKey,
): void {
  drop(cacheKey(tenantId, companyId, module, categoryKey), 'evictions');
}

/**
 * Forget everything for one tenant.
 *
 * Call on logout, and whenever the Drive grant changes — after a disconnect the
 * cached plaintext is data the tenant has just revoked our access to, so
 * keeping it would be both wrong and surprising.
 */
export function flushTenant(tenantId: string): number {
  let dropped = 0;
  for (const [key, entry] of cache) {
    if (entry.tenantId === tenantId) {
      drop(key, 'evictions');
      dropped++;
    }
  }
  return dropped;
}

/** Drop every entry. Used by tests and by key rotation. */
export function flushAll(): void {
  cache.clear();
  totalBytes = 0;
}

/** Observability, and what the tests assert against. */
export function storeCacheStats() {
  return { ...stats, entries: cache.size, bytes: totalBytes, ttlMs: TTL_MS, maxBytes: MAX_BYTES };
}

/** Test-only: reset the counters without touching the entries. */
export function resetStoreCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.staleRefetches = 0;
  stats.evictions = 0;
  stats.expirations = 0;
}
