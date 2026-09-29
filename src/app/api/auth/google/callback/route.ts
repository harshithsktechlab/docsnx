import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { tenants, users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { getAppBaseUrl } from '@/lib/appUrl';
import {
  fetchGoogleAccountEmail,
  getGoogleOAuthClient,
  hasDriveFileScope,
  sanitizeReturnTo,
  serializeDriveTokens,
  verifyOAuthState,
} from '@/lib/googleDrive';
import { eq } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Sends the admin back to where the flow started, with a status for the UI to toast.
 *
 * "Where" is a host as well as a path. This route always runs on the host in the
 * registered redirect URI (`APP_URL`), but nginx also serves the apex name, and
 * the session cookie is host-only — so an admin who started on `docsnx.com` and
 * is returned to `www.docsnx.com` arrives with no session and is bounced to the
 * login screen, with the Drive grant saved and nothing on screen explaining it.
 * `state.origin` is where they came from, already re-validated against this
 * deployment's hosts by `verifyOAuthState`; `APP_URL` is the fallback for a
 * state we could not read.
 */
function backTo(req: Request, returnTo: string, status: string, origin?: string) {
  const url = new URL(sanitizeReturnTo(returnTo), origin || getAppBaseUrl(req));
  url.searchParams.set('google', status);
  return NextResponse.redirect(url);
}

/**
 * Google Drive OAuth callback.
 *
 * Identity here comes from the signed `state`, not the session cookie: the auth
 * cookie is `SameSite=Strict`, so the browser withholds it on this cross-site
 * redirect back from accounts.google.com. The state is a short-lived JWT this
 * app issued to an authenticated tenant admin, so verifying it establishes both
 * who started the flow (CSRF) and which tenant to bind the grant to. The role is
 * re-checked against the database because it may have changed since issuance.
 */
export async function GET(req: Request) {
  const state = verifyOAuthState(new URL(req.url).searchParams.get('state'));
  const returnTo = state?.returnTo ?? '/dashboard';
  /** Every exit from here, success or failure, goes back to the starting host. */
  const back = (status: string) => backTo(req, returnTo, status, state?.origin);

  try {
    if (!state) {
      return back('invalid_state');
    }

    const { searchParams } = new URL(req.url);

    // Google reports user-cancelled consent as ?error=access_denied.
    if (searchParams.get('error')) {
      return back('cancelled');
    }

    const initiator = await db.query.users.findFirst({
      where: eq(users.id, state.userId),
      columns: { id: true, tenantId: true, role: true },
    });

    if (
      !initiator ||
      initiator.tenantId !== state.tenantId ||
      initiator.role !== 'TENANT_ADMIN'
    ) {
      return back('forbidden');
    }

    // If the session cookie did reach us, it must belong to the same account.
    const sessionUser = await getUserFromRequest(req);
    if (sessionUser && sessionUser.id !== initiator.id) {
      return back('invalid_state');
    }

    const code = searchParams.get('code');
    if (!code) {
      return back('missing_code');
    }

    const oauth2Client = getGoogleOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // ── What was actually consented to, not what we asked for ──────────────
    // Google's consent screen offers `drive.file` as a checkbox. Untick it and
    // this callback still receives a code and a perfectly valid token — one that
    // can read the account email and nothing else. Stored, it sets every column
    // that means "connected" while every Drive call answers 403, which leaves
    // the tenant unable to save any record and no screen able to say why.
    //
    // Nothing is written on this path: a tenant whose previous grant was fine
    // must not lose it to a fumbled re-consent.
    if (!hasDriveFileScope(tokens)) {
      return back('missing_drive_scope');
    }

    // Which account consented, so the admin can tell if the grant landed on the
    // wrong one. Best-effort: a failure here must not void a working grant.
    const accountEmail = await fetchGoogleAccountEmail(oauth2Client);

    await withTenant(initiator.tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({
          googleDriveTokens: serializeDriveTokens(tokens), // encrypted at rest
          googleDriveEnabled: true,
          googleAccountEmail: accountEmail,
          // A reconnect may land on a different Google account, where the old
          // folder and file ids mean nothing. Clear them so the next sync
          // rediscovers or recreates the folder instead of writing into a 404.
          googleDriveFolderId: null,
          googleDriveFileIds: null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, initiator.tenantId));

      await writeAudit({
        tenantId: initiator.tenantId,
        userId: initiator.id,
        action: ACTIONS.google_drive.connect,
        // Never log the tokens themselves — only that a grant was stored.
        details: auditSentence('connect', {
          kind: 'Google Drive',
          name: accountEmail || 'an unnamed Google account',
          note: tokens?.refresh_token ? null : 'without a refresh token, so it will need reconnecting',
        }),
        req,
        entityType: 'tenants',
        entityId: initiator.tenantId,
      }, tx);
    });

    return back('connected');
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    return back('error');
  }
}
