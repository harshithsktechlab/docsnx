import { and, eq, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW LONG A NOTIFICATION LIVES                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bell used to DELETE a notification the moment it was clicked, so nothing
 * ever accumulated and nothing could be re-read. Read rows now survive as
 * history, which means something has to be the far end of that — these three
 * numbers are it, and they are the whole retention story:
 *
 *   GET /api/notifications  shows unread in full, plus at most
 *                           READ_HISTORY_LIMIT read rows from the last
 *                           READ_HISTORY_DAYS.
 *   plan-expiry-cron.ts     deletes read rows older than
 *                           NOTIFICATION_RETENTION_DAYS — unreachable by every
 *                           code path well before it prunes them.
 *
 * They live here rather than in the route because a Next.js route module may
 * only export handlers; exporting a constant from one fails the build's route
 * type check.
 */

/** Read notifications returned alongside the unread ones. */
export const READ_HISTORY_LIMIT = 30;

/** How far back the read history reaches. */
export const READ_HISTORY_DAYS = 30;

/** Read notifications older than this are pruned by the daily cron. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** The cutoff a `createdAt >= …` history filter should use. */
export function readHistorySince(now: Date = new Date()): Date {
  return new Date(now.getTime() - READ_HISTORY_DAYS * 24 * 60 * 60 * 1000);
}

/** The cutoff a `createdAt < …` prune should use. */
export function retentionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PUSH HAS TO SAY WHICH WORKSPACE IT IS ABOUT                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bell is scoped to the workspace you are standing in, so a row in it never
 * needs to name one — the chip above it already does. A PUSH has no such luxury:
 * it arrives on a locked phone, where there is no active workspace, no chip and
 * no shell. "Insurance renewal due" is then genuinely ambiguous on an account
 * running a household and three companies.
 *
 * So the workspace goes in the push title and ONLY there. The stored
 * `notifications.title` stays unprefixed, or the panel would repeat what the
 * user can already read off the chrome.
 *
 * ── WHEN TO PREFIX, AND WHY IT IS NOT `accountType === 'both'` ─────────────
 * The obvious rule is the one /billing/expired uses for naming a half — say
 * "Personal" only on an account that HAS two. But that question is about the two
 * HALVES, and this one is about workspaces: a business-only tenant holding Acme
 * and Beta has one half and two workspaces, and a push from either is exactly as
 * ambiguous as it would be on a `both` account.
 *
 * `workspaceMenu().hasChoice` already answers the real question — it is what
 * decides whether the switcher chip is drawn at all — so the invariant becomes
 * one sentence: A PUSH NAMES ITS WORKSPACE EXACTLY WHEN THE APP WOULD DRAW A
 * CHIP NAMING IT. Where there is no chip there is nothing to disambiguate, and
 * the prefix would be noise on every message a household ever receives.
 */

/**
 * How much of a workspace name a title can afford.
 *
 * Android gives a notification title roughly one line and truncates it before it
 * touches the body, so a long company name must not push the actual subject off
 * the screen. Trimmed hard rather than wrapped: half a company name plus the
 * whole subject beats the whole name plus nothing.
 */
export const PUSH_PREFIX_MAX = 18;

/** The separator. A middot reads as attribution; a colon reads as a label. */
const PUSH_SEPARATOR = ' \u00b7 ';

/**
 * `title`, prefixed with the workspace when there is one to name.
 *
 * A null or empty `workspace` returns the title untouched — that is the
 * household on a single-workspace account, and every caller that decided not to
 * prefix.
 */
export function pushTitleFor(title: string, workspace?: string | null): string {
  const name = (workspace || '').trim();
  if (!name) return title;
  const short = name.length > PUSH_PREFIX_MAX
    ? `${name.slice(0, PUSH_PREFIX_MAX - 1).trimEnd()}\u2026`
    : name;
  return `${short}${PUSH_SEPARATOR}${title}`;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH NOTICES BELONG TO THE WORKSPACE YOU ARE STANDING IN              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bell used to be one undifferentiated list over the household and every
 * company. That is the same mistake `collectFollowUps` was corrected for — "a
 * single list mixing both would count a company's licence renewals in the
 * household's badge and show them on a page whose every other surface is
 * personal" — and the bell had it worse, because the badge is the number a user
 * reads without opening anything, and "Mark all read" in one workspace silently
 * cleared every other.
 *
 * ── THE THREE ANSWERS ──────────────────────────────────────────────────────
 *   'personal'   the household — `company_id IS NULL`, which takes the
 *                account-level rows with it for free, because those carry no
 *                company either. That is not a happy accident; it is the same
 *                fact stated once.
 *   a uuid       that company, PLUS the account-level rows.
 *   absent       every workspace. Today's behaviour, and what a client that has
 *                not reloaded since the deploy still asks for.
 *
 * ── WHY ABSENCE MAY MEAN "EVERYTHING" HERE ─────────────────────────────────
 * `resolveWorkspaceFilter` (src/lib/records/companyScope.ts) carries a warning
 * against reusing its unfiltered mode on a route a member can call, because
 * there it would hand them companies they were never granted. It does not apply
 * to this table: every query here is already pinned to `user_id = <the caller>`,
 * so unfiltered means "all of MY OWN notices" — rows this app addressed to this
 * person, in workspaces they could reach when it did. There is no other member's
 * row to spill.
 *
 * An id that IS present is still proven with `hasCompanyAccess` before it
 * reaches a query, for the same reason every other company id is: it arrives
 * from a URL.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A notice everyone sees wherever they stand. Only the billing ladders file these. */
export const ACCOUNT_LEVEL_SCOPE = 'account';

/** Which workspace the bell is asking about. `null` is every workspace. */
export type BellWorkspace = null | 'personal' | string;

/**
 * Reads the bell's workspace off a URL.
 *
 * Returns `undefined` for "present but malformed", which the route turns into a
 * 400 — distinct from `null`, which means absent. `notifications.company_id` is
 * a uuid column and Postgres raises a type error on a bad value, so a filter
 * typo must not be carried as far as a query.
 */
export function bellWorkspaceFrom(url: string): BellWorkspace | undefined {
  const raw = new URL(url).searchParams.get('companyId');
  if (raw === null || raw === '') return null;
  if (raw === 'personal') return 'personal';
  return UUID_RE.test(raw) ? raw.toLowerCase() : undefined;
}

/**
 * The predicate for a resolved workspace, or `undefined` for "every workspace"
 * — dropped into an `and(...)` list, which drizzle skips.
 *
 * Takes the two columns rather than importing the table so this stays a pure
 * function of its inputs, testable without a schema import and reusable by the
 * route's four handlers, which must all filter IDENTICALLY. They did not have
 * to before, because there was nothing to filter; now a GET that scopes and a
 * PATCH that does not is a "Mark all read" that clears what it never showed.
 */
export function inBellWorkspace(
  columns: { companyId: PgColumn; accountScope: PgColumn },
  workspace: BellWorkspace,
): SQL | undefined {
  if (workspace === null) return undefined;
  if (workspace === 'personal') {
    // Covers the account-level rows too — they carry no company either.
    return isNull(columns.companyId);
  }
  return or(
    eq(columns.companyId, workspace),
    eq(columns.accountScope, ACCOUNT_LEVEL_SCOPE),
  );
}

/**
 * The complement of `inBellWorkspace` — everything NOT in this workspace, for
 * the "unread elsewhere" count behind the switcher's dot.
 *
 * ── WHY THIS IS NOT `not(inBellWorkspace(...))` ────────────────────────────
 * Because SQL is three-valued and that negation is quietly wrong. Standing in a
 * company, the filter is `company_id = X OR account_scope = 'account'`; for a
 * HOUSEHOLD row `company_id` is NULL, so `company_id = X` is NULL, the OR is
 * NULL, and `NOT NULL` is NULL — which WHERE treats as no match. The household's
 * unread would have been counted as nothing at all, and the dot that exists
 * precisely to say "there is something in your other workspace" would never have
 * lit for the commonest case it was built for.
 *
 * Nothing about that failure is visible: the count returns 0, which is a
 * perfectly ordinary answer. So the complement is written out, with every NULL
 * accounted for, rather than derived.
 */
export function outsideBellWorkspace(
  columns: { companyId: PgColumn; accountScope: PgColumn },
  workspace: BellWorkspace,
): SQL | undefined {
  // Nothing is "elsewhere" when nothing was filtered out.
  if (workspace === null) return undefined;
  // Every company row, and only those: account-level rows carry no company and
  // are already shown here.
  if (workspace === 'personal') return isNotNull(columns.companyId);
  return and(
    ne(columns.accountScope, ACCOUNT_LEVEL_SCOPE),
    // `ne(company_id, X)` alone is NULL for a household row — the same trap as
    // above, one level down.
    or(isNull(columns.companyId), ne(columns.companyId, workspace)),
  );
}
