/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH WORKSPACES A MEMBER MAY OPEN, AND WHAT THE SWITCHER SAYS         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The switcher itself is JSX in two presentations (a dropdown on desktop, a
 * bottom sheet on a phone). Everything it has to DECIDE lives here instead:
 * which rows exist, where each one goes, and what the chip reads. Two reasons —
 * the two presentations cannot drift apart if they share this, and vitest never
 * collects `src/lib/**` for a `.jsx` component but a `.ts` module is testable
 * from `tests/`.
 *
 * ── THE MENU IS TWO LEVELS, NOT A FLAT LIST ────────────────────────────────
 * The first choice is Personal vs Business; WHICH company is the second. A flat
 * list made Personal and every company peers, so the top-level choice read as a
 * list of strangers rather than as two halves of one account.
 *
 * ── NOTHING HERE IS A PERMISSION DECISION ──────────────────────────────────
 * `companies` arrives from /api/auth/me already filtered to what this member may
 * reach (`accessibleCompanies` in src/lib/auth.ts), and every business route
 * re-proves it with `hasCompanyAccess`. This module renders what it is given.
 */

export type Company = { id: string; name: string };

/** The landing page of one company workspace. */
export function companyHome(companyId: string): string {
  return `/business/${companyId}/dashboard`;
}

/** The landing page of the personal workspace. */
export const PERSONAL_HOME = '/dashboard';

/**
 * Enough of the signed-in member to decide which halves are theirs.
 *
 * `accountScope` is the stored answer to "which account was this member added
 * to" (src/db/schema.ts). It is NOT a permission — what actually stops a
 * business member reading household records is the seeded permission split —
 * but it IS what decides whether they are shown the other half exists at all.
 */
export interface Viewer {
  role?: string | null;
  accountScope?: string | null;
}

export interface WorkspaceMenu {
  /**
   * Whether a Personal row is offered.
   *
   * Only an account holding BOTH halves has a personal workspace to switch to;
   * a business-only tenant has no household side, and offering it a Personal
   * row would be a link to a dashboard with nothing in it.
   *
   * And only a member who HAS a household side. A member added to work on a
   * company has no personal records, no personal permissions and no personal
   * roster — offering them a Personal row would be a link to a dashboard that
   * 403s module by module, and the point of the split is that they should feel
   * like the account has one half, which is the one they were added to.
   */
  hasPersonal: boolean;
  /** The companies, in the order the API returned them (by name). */
  companies: Company[];
  /**
   * Top-level rows: Personal, and Business as ONE row however many companies
   * sit under it. Zero means there is no choice to make and no switcher to
   * draw — the personal-only tenant, which is most of them.
   */
  rowCount: number;
  /**
   * Whether there is more than one place to GO — which is the question the
   * chip's visibility turns on, and it is not `rowCount > 1`.
   *
   * Business is ONE row however many companies sit under it, so a business-only
   * tenant holding Acme and Beta has `rowCount: 1` and two real destinations. A
   * chip hidden there would strand the second company. Conversely a member with
   * one company and no household has one destination and needs no chip: it
   * would open onto a single row naming where they already are.
   */
  hasChoice: boolean;
}

export function workspaceMenu(
  accountType: string | null | undefined,
  companies: readonly Company[] | null | undefined,
  viewer?: Viewer | null,
): WorkspaceMenu {
  const list = Array.isArray(companies) ? companies.filter(Boolean) : [];
  // A TENANT_ADMIN spans both accounts — they create the companies, and both
  // `hasPermission` and `hasCompanyAccess` short-circuit for them. Their own
  // `account_scope` is meaningless and must not be consulted, or the person who
  // owns the workspace would be locked into half of it.
  const spansBoth = !viewer || viewer.role === 'TENANT_ADMIN' || viewer.role === 'SUPER_ADMIN';
  const memberScope = spansBoth ? null : (viewer.accountScope || 'personal');

  // A personal tenant has no business half at all, whatever `companies` says.
  const tenantHasPersonal = accountType === 'both';
  const hasPersonal = tenantHasPersonal && memberScope !== 'business';
  const usable = accountType === 'personal' || memberScope === 'personal' ? [] : list;
  return {
    hasPersonal,
    companies: usable,
    rowCount: (hasPersonal ? 1 : 0) + (usable.length > 0 ? 1 : 0),
    hasChoice: (hasPersonal ? 1 : 0) + usable.length > 1,
  };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WORKSPACE TO OPEN WHEN THE URL NAMES NONE                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `null` means the household — and that is the right answer only for a viewer
 * who HAS one. A tenant whose personal half was erased (`account_type` is
 * 'business' from then on) and a member added to work on a company both have no
 * household at all, and defaulting them there paints an empty personal rail over
 * an account whose every record lives in a company.
 *
 * That is not a cosmetic mismatch. With no personal half and ONE company,
 * `hasChoice` is false and the switcher chip is hidden, so a viewer parked on
 * the household has no control on screen that reaches the company — it reads as
 * having been deleted. Landing them in the company is what makes the hidden chip
 * correct again: there is one workspace and they are in it.
 *
 * Takes the menu rather than rebuilding it, so "which halves are mine" is
 * answered by `workspaceMenu` alone and the two cannot drift.
 */
export function defaultCompanyId(menu: WorkspaceMenu): string | null {
  if (menu.hasPersonal) return null;
  return menu.companies[0]?.id ?? null;
}

/**
 * Where the Business row goes when clicked.
 *
 * With exactly one company it is a link straight into it: a submenu holding a
 * single entry is a tap that asks a question with one answer. With two or more
 * it returns null and the row expands instead.
 */
export function businessHref(companies: readonly Company[] | null | undefined): string | null {
  const list = Array.isArray(companies) ? companies.filter(Boolean) : [];
  return list.length === 1 ? companyHome(list[0].id) : null;
}

export interface ActiveWorkspace {
  kind: 'personal' | 'business';
  companyId: string | null;
  /**
   * Null when the id in the URL names no company this member can reach. The
   * chip then reads a bare "Business" rather than `undefined` — the id is
   * whatever is in the address bar, and the page behind it 403s on its own.
   */
  companyName: string | null;
}

export function activeWorkspace(
  activeCompanyId: string | null | undefined,
  companies: readonly Company[] | null | undefined,
): ActiveWorkspace {
  if (!activeCompanyId) return { kind: 'personal', companyId: null, companyName: null };
  const list = Array.isArray(companies) ? companies : [];
  const match = list.find((c) => c && c.id === activeCompanyId);
  return {
    kind: 'business',
    companyId: activeCompanyId,
    companyName: match ? match.name : null,
  };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FOUR PAGES THAT BELONG TO THE ACCOUNT, NOT TO EITHER WORKSPACE     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Settings, Billing, AI Credits and Audit Logs — everything the avatar menu
 * opens. They are TENANT-level: there is one /settings and one subscription
 * however many companies sit under them, which is why they have no
 * `/business/<id>/…` form and never will.
 *
 * That is also what broke the workspace. The shell reads the open workspace out
 * of the path, these four have no company in their path, so opening one from
 * inside a company flipped the chip, the rail and the bottom nav to Personal
 * mid-session — the user was working in Acme and every navigation control
 * silently decided they had gone home.
 *
 * So they carry `?company=<id>` instead. Two of them already did: /audit-logs
 * and /billing/credits read exactly this param to pick their workspace tab (see
 * WorkspaceTabs.jsx), so the menu setting it selects the right tab as a side
 * effect rather than as a second mechanism.
 */
export const ACCOUNT_PATHS = ['/settings', '/billing', '/billing/credits', '/audit-logs'];

/** Is this one of the four? Exact match — `/billing/expired` is a gate, not one of them. */
export function isAccountPath(pathname: string | null | undefined): boolean {
  return ACCOUNT_PATHS.includes(pathname || '');
}

/**
 * The company a `/business/<id>/…` route names, or null anywhere else.
 *
 * UNVALIDATED, deliberately: the id is whatever is in the address bar, every
 * business route re-proves it with `hasCompanyAccess`, and a company the member
 * cannot reach renders an empty rail and 403s on the way to any data. Checking
 * it here would paint a PERSONAL rail over a business page instead, which is a
 * worse lie than a rail with nothing in it.
 *
 * Exported because Shell needs this reading on its own, separately from
 * `activeCompanyFrom`: the plan lock runs on the PATH company, never on the
 * `?company=` one. See the note at `pathCompanyId` there.
 */
export function companyFromPath(pathname: string | null | undefined): string | null {
  const match = /^\/business\/([^/]+)/.exec(pathname || '');
  return match ? match[1] : null;
}

/**
 * Which company is open, from the whole URL rather than the path alone.
 *
 * The path wins, and the id there stays unvalidated — see `companyFromPath`.
 * That behaviour predates this function and is not changed by it.
 *
 * `?company=` is different, and is validated against `companies`, because it is
 * read on pages that are NOT company routes: nothing behind /settings would
 * ever contradict a bogus id, so an unvalidated one would paint a company rail
 * — with that company's name in the chip — over a page that has nothing to do
 * with it. Anything that is not a company this member can reach therefore falls
 * through to the household: the literal `personal` (which is what the Personal
 * tab on /audit-logs puts there), an absent or empty value, and a stranger's id
 * alike.
 *
 * And only on the four account paths. A stray `?company=` on a personal module
 * page is not a workspace instruction; honouring it there would make every
 * link in the app a potential workspace switch.
 */
export function activeCompanyFrom(
  pathname: string | null | undefined,
  search: string | URLSearchParams | null | undefined,
  companies: readonly Company[] | null | undefined,
): string | null {
  const fromPath = companyFromPath(pathname);
  if (fromPath) return fromPath;

  if (!isAccountPath(pathname) || !search) return null;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const asked = params.get('company');
  if (!asked) return null;

  const list = Array.isArray(companies) ? companies : [];
  return list.some((c) => c && c.id === asked) ? asked : null;
}
