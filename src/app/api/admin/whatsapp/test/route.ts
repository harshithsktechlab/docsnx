/**
 * Send one message through the configured gateway, so a super admin can prove
 * the instance works before anything real depends on it.
 *
 * Audited: this causes an outbound message from the platform's own WhatsApp
 * number, which is exactly the kind of act the trail exists for.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth';
import { sendWhatsAppText, toDialString, getWhatsAppConfig } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

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
        { error: 'WhatsApp is not fully configured. Enable it and select a connected instance first.' },
        { status: 400 },
      );
    }

    const result = await sendWhatsAppText(
      parsed.data.phoneNumber,
      'Test message from your platform WhatsApp gateway. If you can read this, the selected instance is sending correctly.',
    );

    await writeAudit({
      tenantId: user.tenantId, // Super admin's tenant
      userId: user.id,
      action: ACTIONS.whatsapp.test_message,
      details: auditSentence('test_message', {
        kind: 'WhatsApp message',
        note: `${result.success ? 'sent' : 'failed'} to ${number} via instance "${config.instance}"`,
      }),
      entityType: 'system_configs',
      req,
    });

    if (!result.success) {
      // `result.error` is the engine's status, never the message body.
      return NextResponse.json({ error: `Send failed: ${result.error}` }, { status: 502 });
    }

    return NextResponse.json({ success: true, message: `Test message sent to ${number}.` });
  } catch (error) {
    return serverError(error, 'saving test');
  }
}
