import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { setMaxUploadBytes } from './uploadTypes';

const TTL_MS = 60_000;
let lastLoaded = 0;

/**
 * Sync the runtime upload cap (`MAX_UPLOAD_BYTES`) with what the super admin
 * configured, at most once a minute. Called by every server-side enforcement
 * point before it measures a file.
 *
 * NEVER THROWS. This is a cache refresh for one number that already has a
 * working fallback — the limit in memory, or the 25 MB default. A read that
 * fails must leave the upload measured against that, because the alternative is
 * a database hiccup turning every upload in the product into a 500. The failed
 * attempt still moves `lastLoaded`, so a database that is down is retried on
 * the ordinary schedule rather than on every single upload.
 *
 * Server-only: it imports `db`. Never import it from a 'use client' file — the
 * browser's copy of the cap arrives through /api/auth/me instead (see Shell.js).
 */
export async function refreshUploadLimit(): Promise<void> {
  if (Date.now() - lastLoaded < TTL_MS) return;
  lastLoaded = Date.now();
  try {
    const [config] = await db
      .select({ maxUploadBytes: systemConfigs.maxUploadBytes })
      .from(systemConfigs)
      .limit(1);
    setMaxUploadBytes(config?.maxUploadBytes);
  } catch {
    // Keep whatever limit is already in memory. See above.
  }
}
