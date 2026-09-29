/**
 * What `?google=<status>` means, in one place.
 *
 * `/api/auth/google` and its callback are a REDIRECT flow: every exit, success
 * or failure, comes back to the page the admin started on with a status in the
 * query string. Three pages start that flow — Settings, Billing and the
 * onboarding wizard — and the wizard used to read nothing at all, so a
 * cancelled consent screen or an unticked Drive checkbox returned the admin to
 * a step that simply stayed red with no explanation.
 *
 * Keep this list in step with the `back(...)` calls in
 * `src/app/api/auth/google/route.ts` and `.../google/callback/route.ts`.
 * tests/googleConnectResults.test.ts fails if the two drift apart.
 */

/**
 * The Drive permission as Google's own consent screen words it.
 *
 * Quoted verbatim because the whole point of naming it is that the admin can
 * match it against what they saw — a paraphrase ("allow Drive access") sends
 * them looking for a line that is not on the screen. Google shows this one as a
 * CHECKBOX, which is what makes it possible to complete the flow without it.
 */
export const DRIVE_CHECKBOX_LABEL =
  'See, edit, create and delete only the specific Google Drive files you use with this app';

export interface ConnectResult {
  ok: boolean;
  /** One line, for a toast raised the moment the redirect lands. */
  message: string;
  /**
   * The same news for a panel that STAYS — read cold, minutes later, by someone
   * who missed or has forgotten the toast. It therefore repeats the context the
   * toast borrowed from the moment, and says what to do next.
   */
  detail: string;
  /**
   * How loudly to render `detail`. Cancelling is a choice, not a fault, and
   * colouring it like a failure tells the admin something broke when nothing
   * did. `info` renders amber/neutral; `error` renders destructive.
   */
  tone: 'error' | 'info';
}

export const CONNECT_RESULTS: Record<string, ConnectResult> = {
  connected: {
    ok: true,
    message: 'Google Drive connected.',
    detail: 'Google Drive is connected and your workspace can store records.',
    tone: 'info',
  },
  cancelled: {
    ok: false,
    message: 'Google Drive connection was cancelled.',
    detail:
      'You closed Google’s consent screen before finishing, so nothing was connected. ' +
      'Your workspace needs a Google Drive before it can store any records — start the ' +
      'connection again when you are ready.',
    tone: 'info',
  },
  invalid_state: {
    ok: false,
    message: 'That connection link expired. Please try again.',
    detail:
      'The connection link expired before Google sent you back — this usually means the ' +
      'consent screen was left open for a while. Nothing was changed. Start the ' +
      'connection again.',
    tone: 'error',
  },
  missing_code: {
    ok: false,
    message: 'Google did not return an authorization code.',
    detail:
      'Google sent you back without an authorization code, so there was nothing to ' +
      'connect. Nothing was changed. Please try again.',
    tone: 'error',
  },
  forbidden: {
    ok: false,
    message: 'Only a tenant admin can connect Google Drive.',
    detail:
      'Only the account administrator can connect a Google Drive for this workspace. ' +
      'Ask them to complete this step.',
    tone: 'error',
  },
  missing_drive_scope: {
    ok: false,
    message: 'Google Drive was not connected — the Drive tick box was left unticked.',
    // The one message everything here exists for, and the shortest it can be.
    // It must still point at the tick box, because an admin who pressed
    // "Continue" is certain they granted access: the box they missed sits above
    // the button and is optional. It does NOT quote the box's full wording —
    // the pages quote that verbatim BEFORE the admin leaves, where it is a
    // label to match; repeated here it buried the one instruction that matters.
    detail:
      'Google Drive is not connected, so nothing can be saved. On the Google ' +
      'screen, tick the box that lets DocsNX use your Drive files. You can ' +
      'connect again now, or later during onboarding.',
    tone: 'error',
  },
  not_configured: {
    ok: false,
    message: 'Google integration is not configured on this server.',
    detail:
      'Google integration is not configured on this server, so the connection cannot be ' +
      'started. Contact support — this one is not something you can fix from here.',
    tone: 'error',
  },
  error: {
    ok: false,
    message: 'Could not connect Google Drive. Please try again.',
    detail:
      'Something went wrong while connecting Google Drive, and nothing was changed. ' +
      'Please try again — if it keeps happening, contact support.',
    tone: 'error',
  },
};

/**
 * The result for a raw query-string value, or null when there is nothing to say.
 *
 * `Object.hasOwn` rather than a bare index: the status comes off the query
 * string, so `?google=constructor` would otherwise walk the prototype chain and
 * hand the page `Object` — a truthy "result" with no `ok`, whose `detail`
 * renders as nothing at all.
 */
export function connectResult(status: string | null | undefined): ConnectResult | null {
  if (!status || !Object.hasOwn(CONNECT_RESULTS, status)) return null;
  return CONNECT_RESULTS[status];
}
