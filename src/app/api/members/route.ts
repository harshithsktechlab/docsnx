/**
 * The members a record can be assigned to.
 *
 * Exists because there was no endpoint every role could call. The pages that
 * need a holder picker were split across two workarounds:
 *
 *  - `rentals`, `warranty` and `todos` called `/api/users`, which is gated to
 *    TENANT_ADMIN and paginated — so for a STANDARD user the dropdown silently
 *    rendered EMPTY and the console warned. The picker looked broken because
 *    it was.
 *  - `/api/documents` shipped its own `filterOptions.holders` block to dodge
 *    exactly that, which worked but only for one module.
 *
 * This returns id and name and nothing else. It is deliberately not a slice of
 * `/api/users`: that route returns whole user rows with permissions and profile
 * attached, and a picker has no business seeing any of it.
 */
import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { workspaceMembers } from '@/lib/records/workspaceMembers';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // Platform role: tenant membership is not its to enumerate, nor to extend.
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ success: true, members: [], canAddMembers: false });
    }

    /**
     * ── THE PICKER OFFERS THIS WORKSPACE'S MEMBERS, NOT THE TENANT'S ───────
     *
     * "Belongs to" on a company record must not list a family member, and on a
     * household record it must not list an employee. Same gate as every other
     * shared utility, so an unreachable company is a 403 here too.
     *
     * ⚠ This route feeds EVERY holder picker in the app, and it exists because
     * those pickers used to render empty. A predicate that is wrong here is a
     * dropdown that is silently empty everywhere — which is why the fallbacks
     * in `workspaceMembers` are "the admin, at minimum" rather than "no rows".
     */
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    // No permission check on purpose. Knowing who is in your own workspace is
    // not a gated capability — every module's add form needs it, and gating it
    // behind a module key would just recreate the empty-dropdown bug. The
    // predicate is shared with the scan's matcher and the write-side check —
    // see src/lib/records/workspaceMembers.ts for why those three must agree.
    const members = await workspaceMembers(user.tenantId, scope.companyId);

    // Whether this caller may ADD a member, answered here so the holder picker
    // can decide whether to render its "+" without a second /api/auth/me per
    // instance. It mirrors the gate on POST /api/users and nothing more: the
    // route re-checks the role itself, so a forged request still gets a 403.
    const canAddMembers = user.role === 'TENANT_ADMIN';

    return NextResponse.json({ success: true, members, canAddMembers });
  } catch (error) {
    return serverError(error, 'loading members');
  }
}
