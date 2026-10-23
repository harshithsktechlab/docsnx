/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MEMBER INVITE — "<admin> added you as a member in DocsNX"  (0071)      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Sent when a member is given access: on creation with any `can_view`
 * permission, when access is first granted later, from "Give access", and from
 * "Resend invite". It carries a link to /activate and nothing else — no
 * password, no token. On that page the member types their registered number or
 * email, receives a code on both channels, and chooses their own password.
 *
 * ── TWO CHANNELS, EACH OPTIONAL ────────────────────────────────────────────
 *   · WhatsApp, through the approved template `WHATSAPP_INVITE_TEMPLATE`
 *     (default `member_invite`): body {{1}} = who added them, {{2}} = the link.
 *     A business-initiated WhatsApp message must be a template; free text
 *     would be dropped outside the 24-hour window. Until Meta approves the
 *     template the send FAILS, and the result says so rather than pretending.
 *   · Email, when the member has one.
 *
 * A member reachable on neither cannot be invited, and therefore cannot be
 * given sign-in — `canReceiveInvite` is the gate the routes share.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant } from './db';
import { users } from '@/db/schema';
import { toDialString } from './phone';
import { getAppBaseUrl } from './appUrl';
import { isWhatsAppEnabled, sendWhatsAppTemplate } from './whatsapp';
import { sendMemberInviteEmail, sendMembershipInviteEmail } from './mailer';
import { writeAudit, ACTIONS, auditSentence } from './audit';

export const DEFAULT_INVITE_TEMPLATE = 'member_invite';

/** Shortest gap between two invites to one member. */
export const INVITE_COOLDOWN_MS = 60_000;

export type ChannelOutcome = 'sent' | 'failed' | 'skipped';

export interface InviteOutcome {
  whatsapp: ChannelOutcome;
  email: ChannelOutcome;
  /** At least one channel accepted the message. */
  delivered: boolean;
}

export interface InviteTarget {
  id: string;
  name: string | null;
  email: string | null;
  phoneNumber: string | null;
}

/** Which channels could carry an invite to this member right now. Pure. */
export function inviteChannels(
  member: Pick<InviteTarget, 'email' | 'phoneNumber'>,
  whatsappEnabled: boolean,
): { whatsapp: boolean; email: boolean } {
  return {
    whatsapp: whatsappEnabled && Boolean(toDialString(member.phoneNumber)),
    email: Boolean(member.email && member.email.trim()),
  };
}

/** Can this member be invited at all? Pure — the caller supplies the switch. */
export function canReceiveInvite(
  member: Pick<InviteTarget, 'email' | 'phoneNumber'>,
  whatsappEnabled: boolean,
): boolean {
  const c = inviteChannels(member, whatsappEnabled);
  return c.whatsapp || c.email;
}

/** Does a permission set give the member anything to see? */
export function grantsAccess(
  permissions: ReadonlyArray<{ canView?: boolean | null }> | null | undefined,
): boolean {
  return Boolean(permissions?.some((p) => p?.canView));
}

/** The page the invite points at. */
export function activateLink(req?: Request): string {
  return `${getAppBaseUrl(req)}/activate`;
}

/**
 * Send the invite on every channel the member has, stamp `invited_at` and
 * audit it. Never throws for a failed send — the outcome is the whole story,
 * and the member row is already saved by the time this runs.
 */
export async function sendMemberInvite(input: {
  tenantId: string;
  actor: { id: string; name?: string | null };
  member: InviteTarget;
  req?: Request;
  /**
   * 'activate' (default): a brand-new member who must choose a password.
   * 'accept': someone who already has an account (0082) — the link is the plain
   * sign-in page, where the invitation waits for them, and `workspaceName` names
   * what they are being invited to.
   */
  kind?: 'activate' | 'accept';
  workspaceName?: string | null;
}): Promise<InviteOutcome> {
  const { tenantId, actor, member, req, kind = 'activate', workspaceName } = input;
  const channels = inviteChannels(member, await isWhatsAppEnabled());
  const inviter = (actor.name || '').trim() || 'Your family';
  const link = kind === 'accept' ? `${getAppBaseUrl(req)}/login` : activateLink(req);
  const template = process.env.WHATSAPP_INVITE_TEMPLATE?.trim() || DEFAULT_INVITE_TEMPLATE;

  const [wa, mail] = await Promise.all([
    channels.whatsapp
      ? sendWhatsAppTemplate(member.phoneNumber, template, [inviter, link]).catch(() => ({ success: false }))
      : Promise.resolve(null),
    channels.email
      ? (kind === 'accept'
        ? sendMembershipInviteEmail(member.email!, member.name || 'there', inviter, (workspaceName || '').trim() || 'a workspace', link)
        : sendMemberInviteEmail(member.email!, member.name || 'there', inviter, link)
      ).catch(() => ({ success: false }))
      : Promise.resolve(null),
  ]);

  const outcome: InviteOutcome = {
    whatsapp: wa === null ? 'skipped' : wa.success ? 'sent' : 'failed',
    email: mail === null ? 'skipped' : mail.success ? 'sent' : 'failed',
    delivered: Boolean(wa?.success || mail?.success),
  };

  try {
    await withTenant(tenantId, async (tx) => {
      await tx.update(users)
        .set({ invitedAt: new Date() })
        .where(and(eq(users.id, member.id), eq(users.tenantId, tenantId)));
      const sentOn = [
        outcome.whatsapp === 'sent' && 'WhatsApp',
        outcome.email === 'sent' && 'email',
      ].filter(Boolean).join(' and ');
      await writeAudit({
        tenantId,
        userId: actor.id,
        action: ACTIONS.user.invite_sent,
        details: auditSentence('invite_sent', {
          kind: 'member',
          name: member.name,
          note: sentOn ? `sent on ${sentOn}` : 'no channel accepted it',
        }),
        req,
        entityType: 'users',
        entityId: member.id,
      }, tx);
    });
  } catch (error) {
    // The message has already gone; a failed stamp only costs the badge.
    console.error('[memberInvite] could not record the invite:', error);
  }

  return outcome;
}
