/**
 * POST — send a member their invite again (0071).
 *
 * For a member who has sign-in on but has not set their own password yet: the
 * first WhatsApp went to an unapproved template, the email went to spam, or the
 * link simply got lost. Tenant admins only, for a STANDARD member of their own
 * workspace, at most once a minute.
 */
import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { serverError } from '@/lib/routeError';
import { workspaceMemberScope } from '@/lib/account/workspaceMemberScope';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { canReceiveInvite, INVITE_COOLDOWN_MS, sendMemberInvite } from '@/lib/memberInvite';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const currentUser = await getUserFromRequest(req);
    if (!currentUser || currentUser.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;

    const member = await withTenant(currentUser.tenantId, (tx) => tx.query.users.findFirst({
      where: (users, { eq, and, isNull }) => and(
        eq(users.id, id),
        eq(users.tenantId, currentUser.tenantId),
        isNull(users.deletedAt),
      ),
    }));
    if (!member) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const workspace = await workspaceMemberScope(req, currentUser, member as any);
    if ('error' in workspace) return workspace.error;

    if (member.role !== 'STANDARD') {
      return NextResponse.json({ error: 'Only a member can be sent an invite.' }, { status: 403 });
    }
    if (member.activatedAt) {
      return NextResponse.json({ error: 'This member has already set up their account.' }, { status: 400 });
    }
    if (member.signInDisabledAt) {
      return NextResponse.json({ error: 'Turn on sign-in for this member first.' }, { status: 400 });
    }
    if (!canReceiveInvite(member, await isWhatsAppEnabled())) {
      return NextResponse.json({
        error: 'This member has no email, and no mobile number WhatsApp can reach. Use Edit Details to add one.',
      }, { status: 400 });
    }
    if (member.invitedAt && Date.now() - new Date(member.invitedAt).getTime() < INVITE_COOLDOWN_MS) {
      return NextResponse.json({ error: 'An invite was just sent. Try again in a minute.' }, { status: 429 });
    }

    const invite = await sendMemberInvite({
      tenantId: currentUser.tenantId,
      actor: currentUser,
      member: { id: member.id, name: member.name, email: member.email, phoneNumber: member.phoneNumber },
      req,
    });
    return NextResponse.json({ success: true, invite });
  } catch (error) {
    return serverError(error, 'sending a member invite');
  }
}
