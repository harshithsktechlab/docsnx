/**
 * The platform's WhatsApp on/off switch.
 *
 * Sending goes through Meta's WhatsApp Cloud API, whose URL and token are server
 * environment variables (see src/lib/whatsapp.ts). The only thing stored — and
 * the only thing this route changes — is `system_configs.whatsapp_enabled`.
 *
 * `system_configs` is a single platform-wide row with no tenant_id, so there is
 * no `withTenant` here and there is nothing for RLS to scope. SUPER_ADMIN is
 * the whole authorization story, exactly as in /api/admin/smtp.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { getWhatsAppStatus, isMetaConfigured } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  enabled: z.boolean(),
});

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    return NextResponse.json({ success: true, config: await getWhatsAppStatus() });
  } catch (error) {
    return serverError(error, 'fetching WhatsApp config');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { enabled } = parsed.data;

    // A switch that says ON while nothing can send would make every member's
    // sign-in wait for a code that never comes.
    if (enabled && !isMetaConfigured()) {
      return NextResponse.json(
        { error: 'WHATSAPP_BUSINESS_API_URL and WHATSAPP_API_TOKEN are not set on the server. Set them and restart before enabling WhatsApp.' },
        { status: 400 },
      );
    }

    const existing = await db.query.systemConfigs.findFirst();
    if (!existing) {
      // The row is created by the SMTP/settings screens, which have NOT NULL
      // columns this route has no values for. Sending an admin there is honest;
      // inventing an SMTP host is not.
      return NextResponse.json(
        { error: 'Platform settings have not been initialised yet. Save SMTP settings first.' },
        { status: 409 },
      );
    }

    await db
      .update(systemConfigs)
      .set({
        whatsappEnabled: enabled,
        updatedAt: new Date(),
      })
      .where(eq(systemConfigs.id, existing.id));

    await writeAudit({
      tenantId: user.tenantId, // Super admin's tenant
      userId: user.id,
      action: ACTIONS.whatsapp.config_updated,
      details: auditSentence('config_updated', {
        kind: 'WhatsApp gateway',
        note: enabled ? 'enabled' : 'disabled',
      }),
      entityType: 'system_configs',
      entityId: existing.id,
      req,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'updating WhatsApp config');
  }
}
