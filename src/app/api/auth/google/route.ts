import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { getRequestOrigin } from '@/lib/appUrl';
import {
  GOOGLE_DRIVE_SCOPES,
  getGoogleOAuthClient,
  isGoogleOAuthConfigured,
  sanitizeReturnTo,
  signOAuthState,
} from '@/lib/googleDrive';

export const dynamic = 'force-dynamic';

/**
 * Sends the browser back where the flow started, with a status for the UI to toast.
 *
 * This is a redirect flow, so every exit has to be a redirect: returning JSON
 * here would strand the user on a page showing a raw error object.
 *
 * Built on the origin the request came in on, not `APP_URL`. Both are served,
 * the session cookie is host-only, and bouncing an admin from the host they are
 * signed in on to the other one logs them out on the way to an error message.
 */
function backTo(req: Request, returnTo: string, status: string) {
  const url = new URL(sanitizeReturnTo(returnTo), getRequestOrigin(req));
  url.searchParams.set('google', status);
  return NextResponse.redirect(url);
}

/**
 * Starts the BYOD Google Drive consent flow.
 *
 * Connecting binds OAuth credentials for the whole tenant, so it is restricted to
 * the tenant admin. `?returnTo=` (allow-listed internal paths only) travels inside
 * a signed `state` so the callback can send the admin back where they started —
 * the settings page, the onboarding wizard, the billing page, or the backup page.
 */
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.redirect(new URL('/login', getRequestOrigin(req)));
  }

  const { searchParams } = new URL(req.url);
  const returnTo = sanitizeReturnTo(searchParams.get('returnTo'));

  if (user.role !== 'TENANT_ADMIN') {
    return backTo(req, returnTo, 'forbidden');
  }

  if (!isGoogleOAuthConfigured()) {
    return backTo(req, returnTo, 'not_configured');
  }

  const oauth2Client = getGoogleOAuthClient(req);

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_DRIVE_SCOPES,
    // `include_granted_scopes` is deliberately NOT set. It turns on incremental
    // authorization, which issues a token carrying every scope this OAuth
    // CLIENT has ever been granted — not just the two asked for here. Today
    // that is the same set, so the flag changes nothing. The day any flow
    // sharing this client id requests something broader, every tenant's token
    // silently widens to include it, with no new consent screen and no edit to
    // this file. We run one flow with a fixed pair of scopes and gain nothing
    // from incremental auth, so the guarantee is worth more than the flag.
    //
    // `consent` forces the consent screen every time, which is what gets us a
    // refresh token on a reconnect. `select_account` is here for the RETRY
    // case: an admin who left the Drive tick box unticked comes straight back
    // to try again, and without it Google resolves the already-signed-in
    // account silently and can hand back the same decision it already has on
    // file — a loop where the failure message says "tick the box" and the box
    // never reappears. Making the account an explicit choice costs one click
    // on a once-per-tenant flow, and it also stops a grant landing on whatever
    // Google account happened to be signed in, which the callback can only
    // report after the fact.
    prompt: 'consent select_account',
    // `origin` travels with the flow so the callback can return the admin to the
    // host they started on. The callback itself always runs on the registered
    // redirect host, which may not be this one.
    state: signOAuthState({
      tenantId: user.tenantId,
      userId: user.id,
      returnTo,
      origin: getRequestOrigin(req),
    }),
  });

  return NextResponse.redirect(authorizationUrl);
}
