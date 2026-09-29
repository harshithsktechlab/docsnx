/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   COMPANY SCOPING FOR THE SHARED UTILITIES                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Passwords, to-dos and important contacts exist in BOTH accounts — a company
 * has its own credentials, tasks and contacts, and so does the household. That
 * makes their gate subtly different from the record gate in `handler.ts`:
 *
 *   a RECORD module belongs to one taxonomy, so scope and company must AGREE —
 *     a `biz_*` module with no company is a 400, and a personal one with a
 *     company is a 400 too.
 *   a UTILITY belongs to both, so either answer is legitimate. Absent means the
 *     household's; present means that company's. BOTH are proven — see the two
 *     symmetric branches in `resolveUtilityCompany`. "Absent" is a workspace
 *     like any other, not the absence of one, and it went unproven for exactly
 *     as long as it looked like the latter.
 *
 * Hence a second, smaller gate rather than a parameter on the first: conflating
 * them would mean a flag deciding whether "no company" is an error, and that
 * flag would eventually be passed wrongly on a route nobody re-read.
 *
 * What does NOT differ is the proof. The id arrives from the URL and is checked
 * against `companies` scoped to the session's tenant and `company_access`
 * scoped to the session's user, exactly as records are — see the long note on
 * `companyIdFromRequest` for why a company may come from a request when a
 * tenant may never.
 */
import { NextResponse } from 'next/server';
import { eq, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { hasCompanyAccess, hasPersonalAccess } from '@/lib/auth';
import { requireActivePlanFor } from '@/lib/planGate';
import { requireOnboarded } from '@/lib/onboardingGate';
import { companyIdFromRequest } from './handler';

/**
 * The company predicate for any table carrying a nullable `company_id`.
 *
 * `isNull`, never `eq(column, null)`. In SQL `company_id = NULL` is NULL and
 * matches no row, so the personal path would silently return an empty list —
 * which reads as "my passwords are gone", not as a broken predicate.
 *
 * Omitting this from a query does not fail closed. A personal list would show
 * every company's rows and a company's list would show the household's. There
 * is no RLS behind it: both rows share one `tenant_id`, so the policy cannot
 * tell them apart.
 */
export function inCompanyOf(column: PgColumn, companyId: string | null | undefined): SQL {
  return companyId ? eq(column, companyId) : isNull(column);
}

export type CompanyScope =
  | { error: Response }
  | { companyId: string | null };

/**
 * Reads the company off the request and PROVES it.
 *
 * Returns `{ companyId: null }` for the personal account — which is the correct
 * answer for a utility, not a failure.
 */
export async function resolveUtilityCompany(req: Request, user: any): Promise<CompanyScope> {
  const companyId = companyIdFromRequest(req);

  // `undefined` means present-but-malformed. Refused before it reaches a query:
  // these are uuid columns, and a non-UUID is a Postgres type error mid-request
  // — a 500 on what is really a bad value in a URL.
  if (companyId === undefined) {
    return { error: NextResponse.json({ error: 'Invalid company' }, { status: 400 }) };
  }

  if (companyId && !await hasCompanyAccess(user, companyId)) {
    // The same 403 a denied module gets, and deliberately not a 404:
    // distinguishing "no such company" from "not yours" would let a member
    // enumerate the tenant's companies.
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  /**
   * ── AND THE SAME PROOF FOR THE HALF THAT NEEDS NO ID ─────────────────────
   *
   * The branch above proves a company. This one proves the household, and
   * without it there was nothing to prove: absent means `company_id IS NULL`,
   * so a business member who simply omitted `?companyId=` was handed the
   * household's passwords, to-dos and contacts by every route below — each of
   * them having asked a gate that was answering about something else.
   *
   * The four utilities share ONE module key across both accounts, so
   * `hasPermission` cannot tell the halves apart here (its own header says so).
   * This is the whole of the separation, in the same way the company predicate
   * is the whole of it on the other side.
   */
  if (!companyId && !hasPersonalAccess(user)) {
    // The same 403, for the same reason: a member added to work on a company
    // learns nothing about whether a household exists.
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  /**
   * ── THE PLAN GATE FOR THE UTILITIES ──────────────────────────────────────
   *
   * Passwords, to-dos, contacts, documents, follow-up, the dashboard, analysis,
   * search and the scan routes all resolve their workspace through this
   * function, so gating here covers every one of them once.
   *
   * It has to be HERE rather than at the top of each of those routes, which is
   * where `requireActivePlan(user)` used to sit: called before the company was
   * known, it answered for the household on a request about a company, so a
   * lapsed personal plan closed a paid company's passwords.
   *
   * AFTER `hasCompanyAccess`, so a company the caller cannot reach is a 403
   * rather than an invitation to renew a subscription that would not help them.
   *
   * These modules are also the ones `hasPermission` cannot answer per-axis —
   * their module keys are shared between both accounts — so this is not a
   * second line of defence for them, it is the only one.
   */
  const gate = requireActivePlanFor(user, companyId ?? null);
  if (gate) return { error: gate };

  /**
   * ── THE SETUP GATE, COVERING THE SAME NINE ROUTES AT ONCE ────────────────
   *
   * A tenant part-way through the wizard has no Drive grant, and documents,
   * passwords, to-dos and contacts all live in sealed stores on that Drive.
   * Gating here rather than in each route is the same trade the plan gate above
   * makes, and none of the routes the WIZARD itself calls resolve through this
   * function — see the note in `onboardingGate.ts`.
   */
  const setup = requireOnboarded(user);
  if (setup) return { error: setup };

  return { companyId: companyId ?? null };
}

/** The stored mirror of `company_id`. Kept in step by a CHECK constraint. */
export function accountScopeFor(companyId: string | null | undefined): 'personal' | 'business' {
  return companyId ? 'business' : 'personal';
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ACCOUNT-LEVEL READS ASK A THIRD QUESTION                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `resolveUtilityCompany` above has two answers — this company, or the household
 * — because a password belongs to exactly one workspace and a request for one is
 * a request for one.
 *
 * /audit-logs and /billing/credits have a third: ALL OF IT. Their tab strip is
 * `Summary | Personal | <each company>`, and Summary is not a workspace, it is
 * the absence of the filter. So `?companyId=` is read differently here:
 *
 *   absent            → null   → no company predicate at all (Summary)
 *   'personal'        → 'personal' → `company_id IS NULL` (the household)
 *   a UUID            → the id  → that company, once proven
 *   anything else     → 400
 *
 * ── WHY 'personal' IS AN EXPLICIT WORD AND ABSENCE IS NOT ──────────────────
 * The two READ the same on a URL and mean opposite things, so one of them has
 * to be spelled. Absence means "unfiltered" everywhere else in this codebase
 * (`/api/audit-logs` with no query returns the whole trail, and did before this
 * existed), and quietly redefining it to mean "the household" would have
 * shrunk every existing caller's result set without any of them changing.
 *
 * ⚠ These routes are TENANT_ADMIN-only, and Summary spans every company in the
 * tenant. That is safe ONLY because of that role gate: an admin reaches every
 * company in their tenant by construction (`hasCompanyAccess` short-circuits
 * for them). Do not reuse `WORKSPACE_ALL` on a route a member can call — it
 * would hand them the companies they were never granted.
 */
export const WORKSPACE_ALL = null;
export const WORKSPACE_PERSONAL = 'personal';

export type WorkspaceFilter =
  | { error: Response }
  /** `null` = every workspace; `'personal'` = the household; a uuid = that company. */
  | { workspace: null | 'personal' | string };

export async function resolveWorkspaceFilter(req: Request, user: any): Promise<WorkspaceFilter> {
  const raw = new URL(req.url).searchParams.get('companyId');

  if (raw === null || raw === '') return { workspace: WORKSPACE_ALL };
  if (raw === WORKSPACE_PERSONAL) return { workspace: WORKSPACE_PERSONAL };

  // Reuses the SAME reader the record routes use, so the shape check and the
  // lower-casing cannot drift between the two. `undefined` means present but
  // malformed, which must not reach a uuid column.
  const companyId = companyIdFromRequest(req);
  if (!companyId) {
    return { error: NextResponse.json({ error: 'Invalid company' }, { status: 400 }) };
  }
  if (!await hasCompanyAccess(user, companyId)) {
    // The same 403 a denied module gets, and deliberately not a 404:
    // distinguishing "no such company" from "not yours" would let a caller
    // enumerate the tenant's companies.
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { workspace: companyId };
}

/**
 * The predicate for a resolved `WorkspaceFilter`, or `undefined` for Summary.
 *
 * `undefined` rather than a tautology so it can be dropped into an `and(...)`
 * list — drizzle skips undefined members — and so the Summary query keeps using
 * `audit_logs_tenant_created_idx` rather than being pushed onto the
 * company-leading index by a predicate that matches everything.
 */
export function inWorkspace(
  column: PgColumn,
  workspace: null | 'personal' | string,
): SQL | undefined {
  if (workspace === WORKSPACE_ALL) return undefined;
  return inCompanyOf(column, workspace === WORKSPACE_PERSONAL ? null : workspace);
}
