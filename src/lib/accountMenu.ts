/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT THE ACCOUNT MENU OFFERS, AND TO WHOM                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * These four links — Billing, AI Credits, Settings, Audit Logs — used to be an
 * `Account` group at the bottom of the left rail, while Logout was a separate
 * red button in the top-right header and `/more` listed the same destinations
 * again for phones. Three surfaces, one concern, and the destructive action
 * sitting unguarded between Bell and Theme.
 *
 * They are now one avatar menu in the top-right of both headers, which is where
 * "your account" belongs and where the workspace switcher already is.
 *
 * ── WHY THE ROWS LIVE IN A .ts FILE ────────────────────────────────────────
 * Same reason as src/lib/workspaceNav.ts: the menu is JSX in two presentations
 * (an anchored panel on desktop, a bottom sheet on a phone) and vitest cannot
 * import either. Everything the menu has to DECIDE is here, where a test can
 * reach it, so the two presentations cannot drift apart and the role gates can
 * be proven rather than eyeballed.
 *
 * ── NOTHING HERE IS A PERMISSION DECISION ──────────────────────────────────
 * Every page behind these rows re-proves access on arrival — /billing and
 * /billing/credits bounce a non-admin to /dashboard, and /api/audit-logs
 * hard-gates on role. This module decides what is worth OFFERING; the server
 * decides what is allowed.
 */

export type AccountItemKey = 'billing' | 'credits' | 'settings' | 'audit' | 'expired';

export interface AccountItem {
  key: AccountItemKey;
  name: string;
  path: string;
}

/** Where a plan-locked member is sent — the lock screen, not Billing. */
export const PLAN_LOCK_PATH = '/billing/expired';

export interface AccountViewer {
  role?: string | null;
}

/**
 * One account-page link, carrying the workspace it was opened from.
 *
 * ── WHY A QUERY PARAM AND NOT A ROUTE ──────────────────────────────────────
 * These four pages belong to the TENANT, not to either workspace: there is one
 * /settings and one subscription however many companies sit under them. But the
 * shell reads the open workspace out of the path, so an unprefixed link out of a
 * company flipped the chip, the rail and the bottom nav to Personal mid-session
 * — the user was working in Acme and every navigation control silently decided
 * they had gone home. `?company=` keeps the workspace without inventing four
 * company-owned copies of a page whose data is not per company.
 *
 * It is also the param /audit-logs and /billing/credits ALREADY read to pick
 * their workspace tab, so setting it here opens them on the right tab as a side
 * effect rather than as a second mechanism. `ACCOUNT_PATHS` in
 * src/lib/workspaceNav.ts is the other end of this — what the shell reads back.
 *
 * Ordered params, not an object literal in a template string: `axis` before
 * `company` on /billing every time, so a link is stable enough to compare in a
 * test and to read in an address bar.
 */
function withWorkspace(
  path: string,
  companyId: string | null | undefined,
  extra?: Record<string, string>,
): string {
  if (!companyId) return path;
  const params = new URLSearchParams(extra);
  params.set('company', companyId);
  return `${path}?${params.toString()}`;
}

/**
 * The rows above the Logout separator, in display order.
 *
 * Logout is NOT in this list. It is unconditional — every signed-in viewer gets
 * it, including a SUPER_ADMIN and a member who is offered nothing else — so it
 * is rendered by the component rather than being a row that could accidentally
 * be filtered out with the rest.
 *
 * ── THE ROLE GATE IS REAL, NOT DECORATION ──────────────────────────────────
 * The old sidebar group declared `roles: ['TENANT_ADMIN']` and, for a long
 * while, nothing read it: every member saw Billing, AI Credits and Settings,
 * three links that all bounce a non-admin straight back to /dashboard. That is
 * the regression tests/accountMenu.test.ts exists to hold shut.
 *
 * @param planLocked The plan has lapsed (or was never chosen). What survives is
 *   the door that reopens the workspace, and it differs by role: the admin gets
 *   Billing because they are the one who can pay; a member gets the lock screen
 *   instead, because /billing bounces anyone who is not a TENANT_ADMIN and the
 *   two redirects would otherwise ping-pong forever. Both keep Settings.
 * @param companyId The workspace these rows are being opened FROM, or null for
 *   the household. See `withWorkspace` — it is what stops the shell reading a
 *   company-less path as "the user went back to Personal".
 */
export function accountMenuItems(
  viewer: AccountViewer | null | undefined,
  planLocked = false,
  companyId: string | null = null,
): AccountItem[] {
  const role = viewer?.role;

  // The platform admin has no plan, no credits and no audit trail of their own:
  // the trail is tenant-owned and /api/audit-logs denies SUPER_ADMIN outright.
  if (role === 'SUPER_ADMIN') return [];

  /** `/settings` from the household, `/settings?company=acme` from a company. */
  const here = (path: string, extra?: Record<string, string>) =>
    withWorkspace(path, companyId, extra);

  const settings: AccountItem = { key: 'settings', name: 'Settings', path: here('/settings') };
  // `axis=business` is what /billing itself reads to open the right half of the
  // bill; `company` rides along beside it only so the shell keeps the workspace,
  // since a subscription is per ACCOUNT and there is no per-company billing view.
  const billing: AccountItem = {
    key: 'billing',
    name: 'Billing',
    path: here('/billing', companyId ? { axis: 'business' } : undefined),
  };

  if (planLocked) {
    return [
      role === 'TENANT_ADMIN'
        ? billing
        // Deliberately bare. The lock screen is one door out of a lapsed
        // account, not a view of a workspace — and the workspace it would name
        // is the one the member has just been locked out of.
        : { key: 'expired', name: 'Plan Expired', path: PLAN_LOCK_PATH },
      settings,
    ];
  }

  if (role !== 'TENANT_ADMIN') return [];

  return [
    billing,
    { key: 'credits', name: 'AI Credits', path: here('/billing/credits') },
    settings,
    { key: 'audit', name: 'Audit Logs', path: here('/audit-logs') },
  ];
}

/**
 * The two letters in the avatar.
 *
 * There is no avatar column in the schema, so initials ARE the person image.
 * '?' rather than an empty circle for the moment before /api/auth/me answers.
 */
export function getInitials(name?: string | null): string {
  if (!name) return '?';
  const letters = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  return letters || '?';
}
