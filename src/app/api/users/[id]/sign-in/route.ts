/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TURN A MEMBER'S SIGN-IN OFF OR BACK ON — without removing them         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The only way to stop a member signing in used to be DELETE /api/users/[id],
 * which soft-deletes the row and so takes the member out of every holder
 * picker: the admin could no longer file a document under them. This route
 * blocks authentication and nothing else. See `setMemberSignIn` in
 * src/lib/account/memberRemoval.ts for exactly what is kept and what is cleared.
 *
 * Its own route rather than a field on PUT /api/users/[id], because that PUT is
 * the details form's PATCH-shaped save and must not be able to flip this as a
 * side effect of an unrelated edit.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { setMemberSignIn } from '@/lib/account/memberRemoval';
import { workspaceMemberScope } from '@/lib/account/workspaceMemberScope';

const bodySchema = z.object({ enabled: z.boolean() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const currentUser = await getUserFromRequest(req);
    if (!currentUser || currentUser.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Say whether sign-in should be on or off.' }, { status: 400 });
    }
    const { enabled } = parsed.data;

    // The admin's own sign-in is not theirs to turn off here: it would lock
    // the workspace out of the one account that can turn it back on.
    if (id === currentUser.id) {
      return NextResponse.json({ error: 'You cannot turn off your own sign-in.' }, { status: 400 });
    }

    const targetUser = await withTenant(currentUser.tenantId, (tx) => tx.query.users.findFirst({
      where: (users, { eq, and, isNull }) => and(
        eq(users.id, id),
        eq(users.tenantId, currentUser.tenantId),
        isNull(users.deletedAt),
      ),
    }));
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const workspace = await workspaceMemberScope(req, currentUser, targetUser as any);
    if ('error' in workspace) return workspace.error;

    // Only a STANDARD member. Another admin is the tenant's billing and
    // recovery contact, and the platform role is not the tenant's to manage.
    if (targetUser.role !== 'STANDARD') {
      return NextResponse.json({ error: 'Only a member’s sign-in can be turned off.' }, { status: 403 });
    }

    // Already in the asked-for state: answer success without a second audit row.
    if (!!targetUser.signInDisabledAt === !enabled) {
      return NextResponse.json({ success: true, signInDisabled: !enabled });
    }

    await withTenant(currentUser.tenantId, async (tx) => {
      await setMemberSignIn(tx, currentUser, targetUser.id, enabled);
      await writeAudit({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        action: enabled ? ACTIONS.user.sign_in_enable : ACTIONS.user.sign_in_disable,
        details: auditSentence(enabled ? 'sign_in_enable' : 'sign_in_disable', {
          kind: 'member',
          name: targetUser.name,
          note: enabled ? undefined : 'they stay in the workspace and their records are kept',
        }),
        req,
        entityType: 'users',
        entityId: targetUser.id,
      }, tx);
    });

    return NextResponse.json({ success: true, signInDisabled: !enabled });
  } catch (error) {
    return serverError(error, 'changing member sign-in');
  }
}
