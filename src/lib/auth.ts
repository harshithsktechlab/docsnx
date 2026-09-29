import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withTenant } from './db';
import { companies, companyAccess } from '@/db/schema';
import {
  PLAN_EXEMPT_MODULES,
  axisStatus,
  tenantFullyExpired,
} from './planGate';
import { moduleAxisLapsed } from './moduleAxis';

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  tenantId: string;
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is missing.");
}

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

export function signToken(payload: object): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch (error) {
    return null;
  }
}

export interface AuthUser {
  id: string;
  /**
   * NULLABLE since 0040 — a member's address is optional and never verified.
   *
   * Anything that mails an authenticated user, or interpolates this into an
   * audit line, has to cope with its absence. The number in `phoneNumber` is
   * what identifies a member; this may not exist at all.
   */
  email: string | null;
  name: string;
  role: string;
  tenantId: string;
  /**
   * ── "EVERY PLAN THIS ACCOUNT HAS HAS EXPIRED" ────────────────────────────
   *
   * EXPIRED, not "unpaid": a tenant that has simply never chosen a plan reads
   * `false` here, exactly as it always did. The server has never refused a
   * request for a missing subscription — a tenant part-way through signup has
   * no plan yet — and that stays true. See the note above `tenantFullyExpired`.
   *
   * It used to mean "the personal plan is expired", which was the same thing
   * while a tenant had one subscription and is now wrong twice over: a
   * `business` tenant has no personal plan and would never have locked at all,
   * and a `both` tenant's lapsed household would have closed its paid companies.
   *
   * Which axes exist comes from `tenants.account_type` — see
   * `axesForAccountType`. For per-WORKSPACE questions use `planExpiry` below,
   * or better, `requireActivePlanFor(user, companyId)`.
   */
  isExpired: boolean;
  /**
   * Each axis on its own, and expired-only like the flag above. `business` is
   * what decides whether a company workspace is open; `personal` the household's.
   *
   * An axis the tenant does not HAVE reads `false` — nothing has expired,
   * because nothing was ever bought — so this is not a substitute for asking
   * whether the axis exists. `workspaceExpired` does that check for you.
   */
  planExpiry: { personal: boolean; business: boolean };
  permissions: any[];
  tenant: any;
  [key: string]: any; // Allow other fields from safeUser
}

export async function getUserFromRequest(req: Request): Promise<AuthUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('auth_token')?.value;
    
    if (!token) return null;
    
    const decoded = verifyToken(token);
    if (!decoded || !decoded.userId) return null;
    
    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, decoded.userId),
      with: {
        permissions: true,
        tenant: true,
      },
    });
    
    if (!user) return null;

    // A token outlives the account it was minted for: removal and turning
    // sign-in off both have to end sessions already open, not just refuse the
    // next login. The JWT is valid for 7 days, so this check is the only thing
    // that does it.
    if (user.deletedAt || user.signInDisabledAt) return null;

    // Remove password hash for security
    const { passwordHash, ...safeUser } = user;
    
    /**
     * Subscription state, per axis and for the account as a whole. A null expiry
     * is lifetime, not lapsed — see planGate.
     *
     * Both are computed here, once, so every downstream gate reads the same
     * answer. `hasPermission`, `hasCompanyAccess` and `accessibleCompanies` all
     * branch on these three lines further down this file.
     */
    // EXPIRED, not "unpaid" — see the note above `tenantFullyExpired`. These
    // feed `hasPermission` and the company gates, which have never refused a
    // tenant for simply not having chosen a plan yet.
    const lapsedOn = (axis: 'personal' | 'business') =>
      axisStatus(safeUser.tenant, axis).isExpired;

    return {
      ...safeUser,
      isExpired: tenantFullyExpired(safeUser.tenant),
      planExpiry: { personal: lapsedOn('personal'), business: lapsedOn('business') },
    };
  } catch (error) {
    console.error('Error resolving user from request:', error);
    return null;
  }
}

/**
 * Does `user` hold `action` on `module` — and, when given, on that module's
 * `documentKey` sub-category specifically?
 *
 * Permissions carry two grains since migration 0024. Resolution is
 * MOST-SPECIFIC-FIRST and stops at the first row it finds:
 *
 *   1. the exact `(module, documentKey)` override, when a documentKey is asked
 *      for and such a row exists;
 *   2. otherwise the module default, `(module, NULL)`;
 *   3. otherwise deny.
 *
 * Note step 1 is a full override, not an intersection: an override that grants
 * beats a default that denies, which is what makes "deny the module, allow one
 * sub-category" expressible. It is also why an override must never be written
 * without meaning it — see the permissions table comment in src/db/schema.ts.
 *
 * Omitting `documentKey` asks the module-wide question and reads the default
 * row alone, so every pre-0024 three-argument call site keeps its old meaning.
 */
export async function hasPermission(
  user: AuthUser,
  module: string,
  action: 'view' | 'add' | 'edit' | 'delete' | 'share' = 'view',
  documentKey?: string | null,
): Promise<boolean> {
  if (!user) return false;
  // An expired plan denies everything except the renewal path itself: an admin
  // locked out of their own invoice could never pay their way back in.
/**
 * ── WHICH PLAN ANSWERS FOR WHICH MODULE ────────────────────────────────────
 *
 * Three cases, and each has a wrong version that looks like a working app:
 *
 *   biz_*             the BUSINESS plan. Reading the household's here is what
 *                     let a lapsed personal plan deny the modules of a company
 *                     the customer was still paying for.
 *
 *   shared utilities  the ACCOUNT-LEVEL answer. `passwords`, `todos`,
 *                     `emergency_contacts` and `profiles` exist in both halves
 *                     under ONE module key, so this function genuinely cannot
 *                     tell which is being asked about. It denies only when the
 *                     whole account is dead, and the per-workspace gate is
 *                     `resolveUtilityCompany` — which has the company id this
 *                     function does not. Gating them on the personal axis here
 *                     would close a paid company's passwords.
 *
 *   everything else   the PERSONAL plan. These are the household's record
 *                     modules. Reading the account-level flag would leave them
 *                     open while the household's own plan was lapsed, for any
 *                     tenant whose business half was still alive.
 */
  const axisExpired = moduleAxisLapsed(user, module);
  if (axisExpired && !PLAN_EXEMPT_MODULES.has(module)) return false;
  
  if (user.role === 'SUPER_ADMIN') {
    // Deny-by-default allowlist. Note the deliberate absence of 'audit_logs':
    // the audit trail is tenant-owned data and the platform role must not read
    // it. /api/audit-logs additionally hard-gates on role === 'TENANT_ADMIN'.
    const adminModules = ['tenants', 'ai-keys', 'dashboard'];
    return adminModules.includes(module);
  }
  
  if (user.role === 'TENANT_ADMIN') return true;
  
  if (!user.permissions || !Array.isArray(user.permissions)) return false;
  
  const perm = (documentKey
      ? user.permissions.find((p) => p.module === module && p.documentKey === documentKey)
      : undefined)
    ?? user.permissions.find((p) => p.module === module && !p.documentKey);
  if (!perm) return false;
  
  if (action === 'view') return perm.canView;
  if (action === 'add') return perm.canAdd;
  if (action === 'edit') return perm.canEdit;
  if (action === 'delete') return perm.canDelete;
  if (action === 'share') return perm.canShare;
  
  return false;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY GRAIN — may this member reach this company at all?         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Business records carry a THIRD isolation axis that personal ones do not.
 * Tenant isolation has two nets — the explicit `tenantId` predicate and Postgres
 * RLS — but two companies live inside ONE tenant, so `app.tenant_id` is
 * identical for both and RLS cannot tell them apart. **This function is the only
 * net there is.** Every business route must call it before it reads or writes.
 *
 * Deliberately separate from `hasPermission` rather than a third grain inside
 * it. The two answer different questions and combining them would turn the
 * Members screen into companies x 28 modules x 151 sub-categories, and add a
 * resolution step to a function all ~137 routes call:
 *
 *   hasCompanyAccess   WHICH companies this member can see at all
 *   hasPermission      WHAT they may do to a module or sub-category, applied
 *                      inside every company they can reach
 *
 * ── WHO IS LET THROUGH ─────────────────────────────────────────────────────
 * A TENANT_ADMIN reaches every company in their own tenant, the same way
 * `hasPermission` short-circuits to true for them — they are the person who
 * creates companies, and needing to grant themselves access to one they just
 * made is a trap, not a control.
 *
 * SUPER_ADMIN is refused outright. It is a PLATFORM role: it never reads
 * tenant-owned data, which is why `hasPermission` gives it an allowlist of
 * three admin modules and why /api/audit-logs hard-gates on TENANT_ADMIN.
 *
 * ── THE TENANT CHECK IS NOT REDUNDANT ──────────────────────────────────────
 * `company_access` is keyed by (user, company) and carries no tenant column, so
 * on its own a row would let a user reach a company id from ANOTHER tenant if
 * one were ever mis-seeded. The join to `companies` re-asserts the tenant, so
 * both must agree.
 */
export async function hasCompanyAccess(
  user: AuthUser,
  companyId: string | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  // Personal records have no company to check. Callers should not be asking,
  // but answering `true` here keeps a shared code path honest: "no company
  // required" is satisfied.
  if (!companyId) return true;

  if (user.role === 'SUPER_ADMIN') return false;
  /**
   * The BUSINESS axis, not the account-level flag.
   *
   * This function answers "may you reach a company", which is a business
   * question and nothing else — so it is the business plan that decides it.
   * Reading `isExpired` here is what used to let a lapsed household close
   * companies the customer was still paying for.
   *
   * Falls back to the account-level answer when `planExpiry` is absent, which
   * is a hand-built user object in a test rather than a real session.
   */
  if (user.planExpiry?.business ?? user.isExpired) return false;

  const rows = await withTenant(user.tenantId, (tx) =>
    tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(
        eq(companies.id, companyId),
        eq(companies.tenantId, user.tenantId),
        eq(companies.isActive, true),
        isNull(companies.deletedAt),
      ))
      .limit(1),
  );
  // A company that does not exist, belongs to another tenant, is retired or is
  // soft-deleted is unreachable for everyone — admins included.
  if (rows.length === 0) return false;

  if (user.role === 'TENANT_ADMIN') return true;

  const grants = await withTenant(user.tenantId, (tx) =>
    tx
      .select({ id: companyAccess.id })
      .from(companyAccess)
      .where(and(
        eq(companyAccess.userId, user.id),
        eq(companyAccess.companyId, companyId),
      ))
      .limit(1),
  );
  return grants.length > 0;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE HOUSEHOLD GRAIN — may this member reach the personal account?      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `hasCompanyAccess` above answers for a company. This answers for the other
 * half, and it exists because that question turned out to have no answer at all.
 *
 * ── WHY THE SEEDED PERMISSION SPLIT IS NOT ENOUGH ──────────────────────────
 * A member belongs to one account, and for RECORD modules the seeded grant is
 * the whole gate: `PERSONAL_PERMISSION_KEYS` and `BUSINESS_PERMISSION_KEYS` are
 * disjoint, so a business member holds no row for `identity` and is refused it
 * outright. That is still true and still load-bearing — see
 * tests/memberAccountScope.test.ts.
 *
 * But FOUR keys are in both grants on purpose — `passwords`, `todos`,
 * `emergency_contacts` and `profiles` — because a company needs its own
 * credentials, tasks and contacts. For those the permission says only "you may
 * use Passwords" and the `company_id` predicate is supposed to say WHICH. And
 * that predicate has a default: absent means `company_id IS NULL`, the
 * household's. So a business member calling /api/passwords with no company in
 * the query was reading the household's credential list — and revealing them
 * one by one — with every gate answering yes, because none of them was being
 * asked about the household.
 *
 * This function is that missing question. It is to `company_id IS NULL` exactly
 * what `hasCompanyAccess` is to `company_id = <id>`: the only net there is.
 * Neither the tenant predicate nor RLS can help — both halves carry the same
 * `tenant_id`.
 *
 * ── WHY IT READS `account_scope`, WHICH USED TO SAY NOT TO ─────────────────
 * The column's note in src/db/schema.ts said nothing may gate on it. That was
 * written when the permission split genuinely was the whole gate, and before
 * the four utilities were shared across both halves. The schema note now
 * records the amendment: this column gates the household half, and nothing
 * else. What a member may DO once inside either half is still `hasPermission`.
 *
 * ── SYNCHRONOUS, UNLIKE ITS SIBLING ────────────────────────────────────────
 * `account_scope` already rides on the session user from `getUserFromRequest`,
 * so there is nothing to look up. No plan gate either: every caller reaches
 * `requireActivePlanFor(user, null)` immediately afterwards, and answering 402
 * here would mask a 403 with an invitation to renew a subscription that would
 * not help.
 *
 * ⚠ `!== 'business'` and NOT `=== 'personal'`. Anything unrecognised reads as
 * personal — matching `defaultPermissionsFor`, and keeping every row that
 * predates the column working — and a member who spans both accounts will be
 * spelled 'both', which this must let through without an edit.
 */
export function hasPersonalAccess(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  // A PLATFORM role, refused for the same reason `hasCompanyAccess` refuses it:
  // it never reads tenant-owned data.
  if (user.role === 'SUPER_ADMIN') return false;
  // Spans both accounts by construction — they own the household and create the
  // companies. Their own `account_scope` is meaningless and must not be read.
  if (user.role === 'TENANT_ADMIN') return true;
  return (user.accountScope || 'personal') !== 'business';
}

/**
 * Every company this member may reach, for a nav or a picker to render.
 *
 * The list form of `hasCompanyAccess`, and it must stay consistent with it —
 * a company offered here and refused there is a dead link, and the reverse is
 * a company nobody can navigate to.
 */
export async function accessibleCompanies(
  user: AuthUser,
): Promise<{ id: string; name: string }[]> {
  // The business axis, for the same reason `hasCompanyAccess` uses it — and it
  // MUST agree with that function or the switcher offers a dead link.
  if (!user || user.role === 'SUPER_ADMIN') return [];
  if (user.planExpiry?.business ?? user.isExpired) return [];

  return await withTenant(user.tenantId, async (tx) => {
    const live = and(
      eq(companies.tenantId, user.tenantId),
      eq(companies.isActive, true),
      isNull(companies.deletedAt),
    );
    if (user.role === 'TENANT_ADMIN') {
      return await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(live)
        .orderBy(companies.name);
    }
    return await tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .innerJoin(companyAccess, eq(companyAccess.companyId, companies.id))
      .where(and(live, eq(companyAccess.userId, user.id)))
      .orderBy(companies.name);
  });
}

/**
 * The sub-categories of `module` the caller may `action`, out of `candidates`.
 *
 * List endpoints need this rather than a yes/no: a member denied one
 * sub-category should still see the rest of the module, so the query filters to
 * what they hold instead of 403-ing the whole page.
 *
 * Returns [] when nothing is permitted — callers should treat that as an empty
 * list, not as "no filter".
 */
export async function permittedDocumentKeys(
  user: AuthUser,
  module: string,
  candidates: readonly string[],
  action: 'view' | 'add' | 'edit' | 'delete' | 'share' = 'view',
): Promise<string[]> {
  const allowed: string[] = [];
  for (const key of candidates) {
    if (await hasPermission(user, module, action, key)) allowed.push(key);
  }
  return allowed;
}
