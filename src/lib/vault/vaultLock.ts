import pg from 'pg';
import type { CategoryKey } from '../documentCategories';
import { VaultError } from './vaultErrors';
import type { VaultModule } from './vaultNaming';

/**
 * Serialises writes to a single JSON store on Google Drive.
 *
 * Drive offers no compare-and-swap on file content, so two members
 * editing the same category concurrently would each read the store, apply their
 * own change, and write back — the second silently discarding the first. But
 * this app is the only writer and every instance shares one Postgres, so a
 * Postgres advisory lock is a correct and cheap mutex for it.
 *
 * ── WHY A SEPARATE POOL ───────────────────────────────────────────────────
 * The lock is held across a Drive round trip (hundreds of milliseconds). Taking
 * it from the main pool (`max: 20`) would let ~20 concurrent writers consume
 * every connection and stall unrelated queries. A small dedicated pool bounds
 * the damage to vault writes.
 *
 * ── WHY SESSION-LEVEL, NOT TRANSACTION-LEVEL ──────────────────────────────
 * `pg_advisory_xact_lock` would require holding an open transaction across that
 * same Drive call — exactly what the comment at api/documents/route.ts:220-222
 * warns against. Session-level locks let us hold the mutex without holding a
 * transaction, at the cost of an explicit unlock in a `finally`.
 */

const LOCK_POOL_MAX = 5;
const DEFAULT_TRIES = 8;
const DEFAULT_DELAY_MS = 250;

let lockPool: pg.Pool | null = null;

function getLockPool(): pg.Pool {
  if (!lockPool) {
    lockPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: LOCK_POOL_MAX,
      // A leaked lock connection must not pin a slot forever.
      idleTimeoutMillis: 30_000,
    });
    lockPool.on('error', (error) => {
      console.error('[vaultLock] idle client error:', error);
    });
  }
  return lockPool;
}

/** Releases the pool. Tests and graceful shutdown only. */
export async function closeVaultLockPool(): Promise<void> {
  if (lockPool) {
    await lockPool.end();
    lockPool = null;
  }
}

export interface VaultLockKey {
  tenantId: string;
  /** null for a personal store. Two companies hold two independent stores. */
  companyId?: string | null;
  module: VaultModule | string;
  categoryKey: CategoryKey;
}

/**
 * The advisory-lock namespace.
 *
 * Advisory locks are global to the database and share one 64-bit space with any
 * other code that uses them, so the string is prefixed to make an accidental
 * collision with an unrelated feature's lock effectively impossible.
 */
function lockName(key: VaultLockKey): string {
  // The company is in the name, so two companies writing the same category
  // concurrently do not serialise behind each other — and, more importantly,
  // so one company's write is never let through while another holds "the" lock
  // for that category.
  return `docsnx.vault:${key.tenantId}:${key.companyId ?? ''}:${key.module}:`
    + `${key.categoryKey.moduleKey}:${key.categoryKey.documentKey}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VaultLockOptions {
  tries?: number;
  delayMs?: number;
}

/**
 * Runs `fn` while holding the lock for one (tenant, module, category).
 *
 * Failing to acquire is a retryable 409 rather than an indefinite wait: a
 * request blocked behind a slow Drive write should return and let the client
 * retry, not hold a connection until it times out.
 */
export async function withVaultLock<T>(
  key: VaultLockKey,
  fn: () => Promise<T>,
  options: VaultLockOptions = {}
): Promise<T> {
  return await withVaultLocks([key], fn, options);
}

/**
 * Acquires several locks at once, for operations spanning two stores — moving a
 * record between categories reads one and writes both.
 *
 * Keys are sorted before acquisition. Without that, two concurrent moves in
 * opposite directions (A→B and B→A) would each hold one lock and wait forever
 * for the other. Sorting gives every caller the same acquisition order, which
 * makes that deadlock impossible rather than merely unlikely.
 */
export async function withVaultLocks<T>(
  keys: VaultLockKey[],
  fn: () => Promise<T>,
  options: VaultLockOptions = {}
): Promise<T> {
  const tries = options.tries ?? DEFAULT_TRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  const names = [...new Set(keys.map(lockName))].sort();
  if (names.length === 0) return await fn();

  const client = await getLockPool().connect();
  const held: string[] = [];

  try {
    for (const name of names) {
      const acquired = await acquire(client, name, tries, delayMs);
      if (!acquired) {
        throw new VaultError(
          'VAULT_LOCKED',
          `Could not acquire ${name} after ${tries} attempts.`
        );
      }
      held.push(name);
    }

    return await fn();
  } finally {
    // Reverse order, and never let an unlock failure mask the original error.
    for (const name of held.reverse()) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name]);
      } catch (error) {
        console.error(`[vaultLock] failed to release ${name}:`, error);
      }
    }
    client.release();
  }
}

async function acquire(
  client: pg.PoolClient,
  name: string,
  tries: number,
  delayMs: number
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [name]
    );
    if (result.rows[0]?.locked) return true;
    if (attempt < tries - 1) await sleep(delayMs);
  }
  return false;
}
