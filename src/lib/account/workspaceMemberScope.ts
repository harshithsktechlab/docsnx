/**
 * Shared by every /api/users/[id]/* route that acts on one member. Lives here
 * rather than in a route file because a route module may only export handlers.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { companyAccess } from '@/db/schema';
import { resolveUtilityCompany } from '@/lib/records/companyScope';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE MEMBER MUST BE IN THE WORKSPACE THE ADMIN IS STANDING IN           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Not a privilege boundary — both mutations here are already TENANT_ADMIN-only,
 * and an admin owns every member of their tenant either way. It is a CONSISTENCY
 * guard: the rosters are split now, so from inside Acme an admin sees Acme's
 * members, and a request to edit a household member by id from that screen can
 * only be a stale tab or a hand-made call. Answering it would let the two lists
 * disagree about who belongs where.
 *
 * Returns `{ error }` with the Response to send, or `{ companyId }` to proceed.
 *
 * The company comes back rather than being thrown away because PUT needs it
 * twice over: to know which company a "works on" edit must never remove, and to
 * know it was PROVEN rather than read off the query string.
 *
 * `companyId` is null for the cases that return early — a platform role, and an
 * admin target, neither of which has company grants to edit at all.
 *
 * 404 rather than 403, matching what a member of another tenant already gets on
 * this route: from the caller's workspace that member does not exist.
 */
export async function workspaceMemberScope(
  req: Request,
  currentUser: any,
  target: { id: string; role: string; accountScope: string },
): Promise<{ error: Response } | { companyId: string | null }> {
  // The platform role has no workspace, and an admin is a member of every one.
  if (currentUser.role === 'SUPER_ADMIN') return { companyId: null };
  if (target.role === 'TENANT_ADMIN' || target.role === 'SUPER_ADMIN') return { companyId: null };

  const scope = await resolveUtilityCompany(req, currentUser);
  if ('error' in scope) return { error: scope.error };
  const notFound = { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) };

  // Absent reads as 'personal', matching the column default and what every row
  // was before `account_scope` existed. It is NOT NULL in Postgres, so this only
  // ever fires for a row built in a test or by an older path — and the failure
  // mode of getting it wrong is a member who can never be edited or removed.
  const targetScope = target.accountScope || 'personal';

  if (!scope.companyId) {
    return targetScope === 'personal' ? { companyId: null } : notFound;
  }
  if (targetScope !== 'business') return notFound;

  const [grant] = await withTenant(currentUser.tenantId, (tx) => tx
    .select({ id: companyAccess.id })
    .from(companyAccess)
    .where(and(
      eq(companyAccess.userId, target.id),
      eq(companyAccess.companyId, scope.companyId!),
    ))
    .limit(1));
  return grant ? { companyId: scope.companyId } : notFound;
}
