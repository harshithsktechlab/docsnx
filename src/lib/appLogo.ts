import { db } from '@/lib/db';
import { appBranding } from '@/db/schema';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE APPLICATION LOGO — what is stored, and how it is read              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Server-only (imports `db`). The browser never imports this; it reaches the
 * logo through /api/brand/logo, and learns its version from /api/auth/me.
 *
 * The bytes are validated with `sniffAvatarType` (magic bytes; PNG, JPEG, WebP,
 * never SVG, which can carry script and would be served from our own origin).
 */

/** Upper bound on the stored image. The admin page sends ≤512px, ~tens of KB. */
export const MAX_APP_LOGO_BYTES = 512 * 1024;

export type AppLogo = {
  contentType: string;
  bytes: Buffer;
  /** `logo_updated_at` in ms — the ETag and the `?v=` cache-buster. */
  version: number;
};

const TTL_MS = 60_000;
let cache: { at: number; logo: AppLogo | null } | null = null;

/** Drop the cached copy; called by the admin routes after a write. */
export function clearAppLogoCache(): void {
  cache = null;
}

/**
 * The uploaded logo, or null when none has been (use the built-in mark).
 * Cached for a minute because every login/landing page load asks for it.
 *
 * NEVER THROWS: a failed read serves the last known value, or null. A database
 * hiccup must not turn every page's logo into a broken image.
 */
export async function loadAppLogo(): Promise<AppLogo | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.logo;
  try {
    const [row] = await db
      .select({
        contentType: appBranding.logoContentType,
        data: appBranding.logoData,
        updatedAt: appBranding.logoUpdatedAt,
      })
      .from(appBranding)
      .limit(1);
    const logo: AppLogo | null = row
      ? {
          contentType: row.contentType,
          bytes: Buffer.from(row.data, 'base64'),
          version: new Date(row.updatedAt).getTime(),
        }
      : null;
    cache = { at: Date.now(), logo };
    return logo;
  } catch {
    // Keep serving what we had. Retry on the ordinary schedule.
    cache = { at: Date.now(), logo: cache?.logo ?? null };
    return cache.logo;
  }
}

/** Just the version, for /api/auth/me. 0 means "built-in mark". */
export async function loadAppLogoVersion(): Promise<number> {
  return (await loadAppLogo())?.version ?? 0;
}
