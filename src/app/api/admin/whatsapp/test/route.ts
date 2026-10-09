/**
 * Send one verification-code message through Meta, so a super admin can prove
 * WhatsApp works before anything real depends on it.
 *
 * Uses the same approved OTP template real codes go out with, with a dummy
 * code. A free-form text test would only arrive inside Meta's 24-hour window
 * and so would "fail" while real codes were being delivered fine.
 *
 * Audited: this causes an outbound message from the platform's own WhatsApp
 * number, which is exactly the kind of act the trail exists for.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth';
import { sendWhatsAppOtp, toDialString, getWhatsAppConfig } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** Not a real code: it is never stored and redeems nothing. */
const TEST_CODE = '123456';

const bodySchema = z.object({
  phoneNumber: z.string().trim().min(8).max(50),
});

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'A valid phone number is required.' }, { status: 400 });
    }

    const number = toDialString(parsed.data.phoneNumber);
    if (!number) {
      return NextResponse.json({ error: 'That phone number is too short to dial.' }, { status: 400 });
    }

    const config = await getWhatsAppConfig();
    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp is not enabled, or the Meta credentials are missing on the server.' },
        { status: 400 },
      );
    }

    const result = await sendWhatsAppOtp(parsed.data.phoneNumber, TEST_CODE);

    await writeAudit({
      tenantId: user.tenantId, // Super admin's tenant
      userId: user.id,
      action: ACTIONS.whatsapp.test_message,
      details: auditSentence('test_message', {
        kind: 'WhatsApp message',
        note: `${result.success ? 'sent' : 'failed'} to ${number} via Meta`,
      }),
      entityType: 'system_configs',
      req,
    });

    if (!result.success) {
      // `result.error` is Meta's HTTP status, never the message body.
      return NextResponse.json({ error: `Send failed: ${result.error}` }, { status: 502 });
    }

    return NextResponse.json({ success: true, message: `Test code 123456 sent to ${number}.` });
  } catch (error) {
    return serverError(error, 'saving test');
  }
}
