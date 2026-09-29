/**
 * The platform's WhatsApp gateway configuration.
 *
 * Its own route rather than four more fields on /api/admin/settings, because
 * that route's PUT writes `smtpPassword` straight through while /api/admin/smtp
 * encrypts it — a round trip through the settings page re-saves ciphertext as
 * plaintext. The API key here is a bearer credential for the whole engine and
 * must not be able to end up in that state.
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
import { encrypt } from '@/lib/encryption';
import { getStoredKeyFingerprint } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  enabled: z.boolean().optional(),
  apiUrl: z.string().trim().max(255).optional().nullable(),
  /**
   * BLANK MEANS "KEEP THE STORED KEY". The GET below never hands the key to the
   * browser, so the form has nothing to send back — an empty string is what a
   * save looks like when the admin only changed the instance.
   */
  apiKey: z.string().optional().nullable(),
  instance: z.string().trim().max(255).optional().nullable(),
});

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const config = await db.query.systemConfigs.findFirst();

    // `hasApiKey`, never the key. A super admin needs to know whether one is
    // stored, not what it is; nothing in the UI requires reading it back.
    //
    // The fingerprint is the one exception, and it is a shape and not a secret:
    // a length plus a SHA-256 prefix. Without it "the engine rejected the key"
    // is unfalsifiable from the browser — a truncated paste and a genuinely
    // wrong key look identical — and the admin's only move is to paste again
    // and hope. See getStoredKeyFingerprint for why it is a hash rather than
    // the leading characters the CLI checker prints.
    const keyFingerprint = await getStoredKeyFingerprint();

    return NextResponse.json({
      success: true,
      config: {
        enabled: config?.whatsappEnabled ?? false,
        apiUrl: config?.whatsappApiUrl ?? '',
        instance: config?.whatsappInstance ?? '',
        hasApiKey: !!config?.whatsappApiKey,
        keyFingerprint,
      },
    });
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
    const { enabled, apiUrl, instance } = parsed.data;
    const apiKey = parsed.data.apiKey?.trim() || '';

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
        whatsappEnabled: !!enabled,
        whatsappApiUrl: apiUrl || null,
        whatsappInstance: instance || null,
        // Only overwrite the key when a new one was actually typed.
        ...(apiKey ? { whatsappApiKey: encrypt(apiKey) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(systemConfigs.id, existing.id));

    await writeAudit({
      tenantId: user.tenantId, // Super admin's tenant
      userId: user.id,
      action: ACTIONS.whatsapp.config_updated,
      details: auditSentence('config_updated', {
        kind: 'WhatsApp gateway',
        note: [
          enabled ? 'enabled' : 'disabled',
          instance && `instance "${instance}"`,
          apiKey && 'API key replaced',
        ].filter(Boolean).join(', '),
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
