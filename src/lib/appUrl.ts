/**
 * Resolves the public base URL of this deployment — the origin that must appear
 * in anything a user receives outside the browser (password-reset links, OAuth
 * redirect URIs, emailed deep links).
 *
 * Never build such a URL from `PORT` alone: behind nginx the app listens on
 * 127.0.0.1:3005, so that yields `http://localhost:3005`, which is unusable from
 * a recipient's inbox.
 *
 * Precedence (first non-empty wins):
 *   1. APP_URL             — pinned per deployment (systemd unit in production).
 *   2. NEXT_PUBLIC_APP_URL — the var the Google OAuth routes already use.
 *   3. The incoming request's forwarded host/proto (nginx sets `Host` and
 *      `X-Forwarded-Proto`). Convenient for local dev; see the caveat below.
 *   4. http://localhost:${PORT ?? 3005} — last resort, dev only.
 *
 * Caveat on rule 3: the host comes from a client-controlled header, so a spoofed
 * `Host` could poison a link that is then emailed to someone else. Production
 * must always set APP_URL so that branch is never reached.
 */

const DEFAULT_PORT = '3005';

/** Trim, add a scheme if missing, drop any trailing slash. */
function normalize(url: string | undefined | null): string | null {
  const raw = (url || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

export function getAppBaseUrl(req?: Request): string {
  const configured = normalize(process.env.APP_URL) || normalize(process.env.NEXT_PUBLIC_APP_URL);
  if (configured) return configured;

  const host = req?.headers.get('x-forwarded-host') || req?.headers.get('host');
  if (host) {
    const proto = req?.headers.get('x-forwarded-proto') || 'http';
    return normalize(`${proto}://${host}`)!;
  }

  return `http://localhost:${process.env.PORT || DEFAULT_PORT}`;
}

/**
 * The origin the browser is ACTUALLY on, which is not always `getAppBaseUrl()`.
 *
 * nginx answers on both `docsnx.com` and `www.docsnx.com` while `APP_URL` names
 * only the second. The session cookie is host-only, so redirecting someone who
 * is on the apex host to a URL built from `APP_URL` lands them on a host where
 * they have no session — which is exactly how finishing the Google Drive consent
 * used to end at the login screen.
 *
 * Use this for redirects that send the CURRENT browser somewhere in this app.
 * Do NOT use it for anything that leaves the process — emailed links and the
 * OAuth `redirect_uri` must stay pinned to `APP_URL`, because the host here
 * comes from a client-controlled header and because Google matches the redirect
 * URI against one registered string.
 */
export function getRequestOrigin(req?: Request): string {
  const host = req?.headers.get('x-forwarded-host') || req?.headers.get('host');
  if (!host) return getAppBaseUrl(req);
  const proto = req?.headers.get('x-forwarded-proto') || 'http';
  return normalize(`${proto}://${host}`)!;
}

/** `docsnx.com` and `www.docsnx.com` are the same deployment; anything else is not. */
function hostVariants(host: string): string[] {
  const bare = host.replace(/^www\./i, '');
  return [bare, `www.${bare}`];
}

/**
 * Whether an origin belongs to this deployment.
 *
 * The guard on `getRequestOrigin`: an origin derived from a spoofed `Host` and
 * then carried inside a signed OAuth state would come back as a redirect target,
 * i.e. an open redirect on our own signature. Only the configured host and its
 * apex/`www` counterpart pass. Falls back to the request's own origin when
 * nothing is configured (dev, where `getAppBaseUrl` is the request host anyway).
 */
export function isAllowedAppOrigin(origin: string | null | undefined, req?: Request): boolean {
  const candidate = normalize(origin);
  if (!candidate) return false;

  let candidateHost: string;
  try {
    candidateHost = new URL(candidate).host.toLowerCase();
  } catch {
    return false;
  }

  try {
    const baseHost = new URL(getAppBaseUrl(req)).host.toLowerCase();
    return hostVariants(baseHost).includes(candidateHost);
  } catch {
    return false;
  }
}
