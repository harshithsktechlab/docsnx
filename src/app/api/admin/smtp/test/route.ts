/**
 * Send one message through the configured mail transport, so a super admin can
 * prove it works before anything real depends on it. Mirrors
 * /api/admin/whatsapp/test.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The SMTP settings were re-entered after a rebuild with port 587 and implicit
 * TLS ticked — a pair that cannot connect — and every verification code, every
 * password reset and every plan notice failed silently for a month. There was
 * nothing an operator could press to find that out. This is that button.
 *
 * ── WHERE IT SENDS, AND WHY NOT ANYWHERE ELSE ──────────────────────────────
 * To the CALLER'S OWN address, read from their session. Never an address from
 * the request body: an authenticated relay that mails arbitrary text to an
 * arbitrary recipient from the platform's own From header is a spam cannon with
 * a login, and the test is just as conclusive sent to oneself.
 */
import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { sendTestEmail } from '@/lib/mailer';
import { smtpFailureExplanation } from '@/lib/smtpSecurity';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    if (!user.email) {
      return NextResponse.json(
        { error: 'Your own account has no email address, so there is nowhere to send the test.' },
        { status: 400 },
      );
    }

    const result = await sendTestEmail(user.email, user.name || 'there');

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.smtp.test_email,
      details: auditSentence('test_email', {
        kind: 'SMTP test email',
        note: result.success
          ? `sent to ${user.email}`
          : `failed at ${result.stage}`,
      }),
      entityType: 'system_configs',
      req,
    });

    if (!result.success) {
      // The transport's own words, quoted. Safe here in a way it is not on the
      // public auth routes: this endpoint is SUPER_ADMIN-only, and "wrong
      // version number" is the single most useful string in this whole change —
      // it is what identifies a port/TLS mismatch at a glance.
      //
      // Useful, though, only to someone who already knows what it means. So the
      // plain-language cause leads and the raw error follows it in brackets: the
      // administrator gets the next step in the first sentence, and a support
      // ticket still carries the string an engineer would ask for.
      const prefix = result.stage === 'connect'
        ? 'Could not connect to the mail server'
        : result.stage === 'config'
          ? 'Not configured'
          : 'Connected, but the message was rejected';
      const explanation = smtpFailureExplanation(result.error);
      const error = explanation
        ? `${prefix}. ${explanation} (Technical detail: ${result.error})`
        : `${prefix}: ${result.error}`;
      return NextResponse.json({ error }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      message: `Test email sent to ${user.email}. If it does not arrive, check the spam folder before changing anything.`,
    });
  } catch (error) {
    return serverError(error, 'sending the SMTP test email');
  }
}
