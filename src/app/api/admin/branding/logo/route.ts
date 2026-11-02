import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appBranding } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { sniffAvatarType } from '@/lib/avatarImage';
import { MAX_APP_LOGO_BYTES, clearAppLogoCache } from '@/lib/appLogo';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE APPLICATION LOGO — upload, reset, status                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Super admin only; platform-wide. The body of PUT is the raw image bytes (the
 * browser has already downsized it); the stored type comes from the magic
 * bytes, not from the request. Serving the logo is /api/brand/logo.
 *
 * This is the APPLICATION's logo. The invoice entity's logo is
 * `system_configs.platform_logo`, edited under Admin → Settings → Invoicing.
 */

export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const [row] = await db
      .select({ updatedAt: appBranding.logoUpdatedAt })
      .from(appBranding)
      .limit(1);
    return NextResponse.json({
      success: true,
      isCustom: !!row,
      updatedAt: row ? new Date(row.updatedAt).getTime() : null,
    });
  } catch (error) {
    return serverError(error, 'fetching the logo status');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    // Refuse on the declared length first so an oversized body is never buffered.
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_APP_LOGO_BYTES + 1024) {
      return NextResponse.json({ error: 'That logo is too large. Choose a smaller one.' }, { status: 413 });
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) {
      return NextResponse.json({ error: 'No logo was sent.' }, { status: 400 });
    }
    if (bytes.length > MAX_APP_LOGO_BYTES) {
      return NextResponse.json({ error: 'That logo is too large. Choose a smaller one.' }, { status: 413 });
    }
    const contentType = sniffAvatarType(bytes);
    if (!contentType) {
      return NextResponse.json({ error: 'Use a PNG, JPEG or WebP logo.' }, { status: 400 });
    }

    const now = new Date();
    const data = Buffer.from(bytes).toString('base64');

    // Singleton: update the row if there is one, otherwise create it.
    const [existing] = await db.select({ id: appBranding.id }).from(appBranding).limit(1);
    if (existing) {
      await db.update(appBranding)
        .set({ logoContentType: contentType, logoData: data, logoUpdatedAt: now, updatedAt: now })
        .where(eq(appBranding.id, existing.id));
    } else {
      await db.insert(appBranding)
        .values({ logoContentType: contentType, logoData: data, logoUpdatedAt: now });
    }
    clearAppLogoCache();

    await writeAudit({
      action: ACTIONS.system_config.app_logo_updated,
      details: auditSentence('update', { kind: 'application logo', note: 'uploaded a new logo' }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'app_branding',
      req,
    });

    return NextResponse.json({ success: true, updatedAt: now.getTime() });
  } catch (error) {
    return serverError(error, 'saving the logo');
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const removed = await db.delete(appBranding).returning({ id: appBranding.id });
    clearAppLogoCache();

    if (removed.length > 0) {
      await writeAudit({
        action: ACTIONS.system_config.app_logo_removed,
        details: auditSentence('update', { kind: 'application logo', note: 'reset to the built-in logo' }),
        tenantId: user.tenantId,
        userId: user.id,
        entityType: 'app_branding',
        req,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'resetting the logo');
  }
}
