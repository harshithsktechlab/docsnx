import { NextResponse } from 'next/server';
import { loadAppLogo } from '@/lib/appLogo';
import { BUILT_IN_APP_MARK } from '@/lib/brand';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE APPLICATION LOGO — public                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Deliberately UNAUTHENTICATED: the login, register, forgot-password and landing
 * pages render the logo to people who have no session, and so do the favicon,
 * the PWA manifest and push notification icons. It exposes only the logo.
 *
 * Served from our own origin, so it is locked down the way the avatar route is:
 * `nosniff` plus a sandboxing CSP, and only raster types ever get stored.
 *
 * `no-cache` rather than a long max-age: the URL is not versioned in every
 * place that uses it (the manifest, the favicon), so browsers revalidate with
 * the ETag, which is a 304 answered from a one-minute in-memory cache.
 *
 * No uploaded logo → redirect to the built-in mark.
 */
const BUILT_IN = BUILT_IN_APP_MARK;

export async function GET(req: Request) {
  const logo = await loadAppLogo();

  if (!logo) {
    return new NextResponse(null, {
      status: 302,
      headers: { Location: BUILT_IN, 'Cache-Control': 'no-store' },
    });
  }

  const etag = `"logo-${logo.version}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(new Uint8Array(logo.bytes), {
    status: 200,
    headers: { ...headers, 'Content-Type': logo.contentType },
  });
}
