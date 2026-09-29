/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHO IS "A MEMBER" OF A WORKSPACE — one predicate, three callers        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The "Belongs to" picker lists a workspace's members, the scan matches the
 * names it reads against them, and a write accepts a holder only if it is one
 * of them. Those three must agree: a member the picker offers but the write
 * refuses is a save that fails for no visible reason, and a member the scan
 * matches but the picker does not list is a row showing a name nobody can pick.
 *
 *   household   the tenant admins, plus every member whose account is personal
 *   company     the tenant admins (who reach every company without a grant),
 *               plus every member holding a `company_access` row for it
 *
 * A LABEL, not access control — exactly as in the personal vault. Filing a
 * company record under a director hides it from nobody; `hasPermission` and
 * `hasCompanyAccess` decide visibility and nothing here changes that.
 *
 * Its own module rather than part of ./handler.ts: about ten suites mock that
 * module exhaustively, and a new export there is a new undefined in each.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { type db, withTenant } from '@/lib/db';
import { users, companyAccess } from '@/db/schema';

type Tx = typeof db;

/** The WHERE for "a live member of this workspace", inside a tenant transaction. */
async function memberPredicate(tx: Tx, tenantId: string, companyId: string | null | undefined): Promise<SQL> {
  const base = [eq(users.tenantId, tenantId), isNull(users.deletedAt)];
  if (companyId) {
    const grants = await tx
      .select({ userId: companyAccess.userId })
      .from(companyAccess)
      .where(eq(companyAccess.companyId, companyId));
    const grantedIds = grants.map((g: any) => g.userId);
    base.push(
      grantedIds.length
        ? or(eq(users.role, 'TENANT_ADMIN'), inArray(users.id, grantedIds))!
        : eq(users.role, 'TENANT_ADMIN'),
    );
  } else {
    base.push(or(eq(users.role, 'TENANT_ADMIN'), eq(users.accountScope, 'personal'))!);
  }
  return and(...base)!;
}

/**
 * The same rule as a single SQL condition on `users`, for a caller that already
 * holds a transaction and looks one member up through it (the to-do assignee
 * check). The grant is an EXISTS rather than a pre-read id list, so it costs no
 * second statement. Tenant and `deletedAt` are the caller's to state.
 */
export function inWorkspace(companyId: string | null | undefined): SQL {
  return companyId
    ? or(
        eq(users.role, 'TENANT_ADMIN'),
        sql`exists (select 1 from ${companyAccess} where ${companyAccess.userId} = ${users.id} and ${companyAccess.companyId} = ${companyId})`,
      )!
    : or(eq(users.role, 'TENANT_ADMIN'), eq(users.accountScope, 'personal'))!;
}

/**
 * Every member of the workspace, id and name only, ordered by name.
 *
 * `signInDisabled` rides along so a picker can label them. Such a member is
 * still listed on purpose: their sign-in being off is exactly when the admin
 * is filing records for them.
 *
 * `companyId` must already be PROVEN for the caller (`hasCompanyAccess` /
 * `resolveUtilityCompany`) — this answers "who is in it", not "may you ask".
 */
export async function workspaceMembers(
  tenantId: string,
  companyId: string | null | undefined,
  tx?: Tx,
): Promise<Array<{ id: string; name: string; signInDisabled: boolean }>> {
  const run = async (t: Tx) => (await t
    .select({ id: users.id, name: users.name, signInDisabledAt: users.signInDisabledAt })
    .from(users)
    .where(await memberPredicate(t, tenantId, companyId))
    .orderBy(users.name))
    .map(({ signInDisabledAt, ...m }) => ({ ...m, signInDisabled: !!signInDisabledAt }));
  return tx ? run(tx) : withTenant(tenantId, run);
}

/**
 * Is `holderId` a live member of this workspace?
 *
 * The write-side half of the picker. `assertHolderInTenant` alone would let a
 * household member's id be filed onto a company record — the picker never
 * offers that, but a request is not the picker.
 */
export async function isWorkspaceMember(
  tenantId: string,
  holderId: string,
  companyId: string | null | undefined,
): Promise<boolean> {
  const [hit] = await withTenant(tenantId, async (t) => t
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, holderId), await memberPredicate(t, tenantId, companyId)))
    .limit(1));
  return Boolean(hit);
}
