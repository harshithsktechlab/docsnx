import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import {
  DEFAULT_ENTITY_TYPES, loadStoredEntityTypes, normalizeOptions,
} from '@/lib/profileFieldOptions';
import { serverError } from '@/lib/routeError';

/**
 * The company profile's dropdown lists, edited under Field Config → Company
 * Profile. Super admin only; platform-wide, like the upload cap beside it.
 */

export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const stored = await loadStoredEntityTypes();
    return NextResponse.json({
      success: true,
      // What the form currently offers — the stored list, or the defaults.
      entityType: stored ?? DEFAULT_ENTITY_TYPES,
      isDefault: stored === null,
      defaults: { entityType: DEFAULT_ENTITY_TYPES },
    });
  } catch (error) {
    return serverError(error, 'fetching company profile options');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const body = await req.json().catch(() => null);
    // null / [] resets to the built-in list.
    const raw = body?.entityType;
    let next: unknown = null;
    if (Array.isArray(raw) && raw.length > 0) {
      const checked = normalizeOptions(raw);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      next = checked.options;
    } else if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
      return NextResponse.json({ error: 'entityType must be a list of choices.' }, { status: 400 });
    }

    /**
     * UPDATE only, never INSERT — see file-size/route.ts. `system_configs` is a
     * single row whose SMTP columns are NOT NULL, so an absent row is a setup
     * step to report, not something to invent a gateway for.
     */
    const [config] = await db.select({ id: systemConfigs.id }).from(systemConfigs).limit(1);
    if (!config) {
      return NextResponse.json(
        { error: 'Platform settings have not been set up yet. Save them under Admin → Settings first.' },
        { status: 409 },
      );
    }

    await db.update(systemConfigs)
      .set({ profileFieldOptions: next ? { entityType: next } : null, updatedAt: new Date() })
      .where(eq(systemConfigs.id, config.id));

    await writeAudit({
      action: ACTIONS.system_config.profile_options_updated,
      details: auditSentence('update', {
        kind: 'company profile options',
        note: next ? `Entity Type: ${(next as unknown[]).length} choices` : 'Entity Type: default list',
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'system_config',
      req,
    });

    return NextResponse.json({ success: true, entityType: next ?? DEFAULT_ENTITY_TYPES, isDefault: !next });
  } catch (error) {
    return serverError(error, 'updating company profile options');
  }
}
