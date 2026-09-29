import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { setMaxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES, UPLOAD_LIMIT_CEILING_BYTES } from '@/lib/records/uploadTypes';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const [config] = await db.select({
      maxUploadBytes: systemConfigs.maxUploadBytes,
    }).from(systemConfigs).limit(1);

    return NextResponse.json({
      success: true,
      maxUploadBytes: config?.maxUploadBytes ?? null,
      defaultMaxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      ceilingBytes: UPLOAD_LIMIT_CEILING_BYTES,
    });
  } catch (error) {
    return serverError(error, 'fetching upload limit settings');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const body = await req.json();
    const { maxUploadBytes } = body;

    const n = maxUploadBytes !== undefined && maxUploadBytes !== null ? Number(maxUploadBytes) : null;

    if (n !== null) {
      // Whole bytes: the column is `integer`, and a fractional value would be
      // a rounding surprise at the database rather than an answer here.
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json(
          { error: 'Max upload size must be a whole positive number of bytes.' },
          { status: 400 }
        );
      }
      if (n > UPLOAD_LIMIT_CEILING_BYTES) {
        return NextResponse.json(
          {
            error: `Max upload size cannot exceed ${UPLOAD_LIMIT_CEILING_BYTES / (1024 * 1024)} MB (nginx limit).`,
          },
          { status: 400 }
        );
      }
    }

    /**
     * UPDATE only, never INSERT. `system_configs` is a single row created when
     * the platform is first configured, and five of its columns (the SMTP
     * five) are NOT NULL with no default — a row seeded from here would have to
     * invent an outbound mail gateway to satisfy them. So an absent row is
     * reported as the setup step it actually is, rather than as the not-null
     * violation an insert would raise.
     */
    const [config] = await db.select({ id: systemConfigs.id }).from(systemConfigs).limit(1);
    if (!config) {
      return NextResponse.json(
        { error: 'Platform settings have not been set up yet. Save them under Admin → Settings first.' },
        { status: 409 },
      );
    }

    await db.update(systemConfigs)
      .set({ maxUploadBytes: n, updatedAt: new Date() })
      .where(eq(systemConfigs.id, config.id));

    setMaxUploadBytes(n);

    const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
    const mbValue = n !== null ? mb(n) : `default (${mb(DEFAULT_MAX_UPLOAD_BYTES)})`;
    await writeAudit({
      action: ACTIONS.system_config.upload_limit_updated,
      details: auditSentence('update', {
        kind: 'upload limit',
        note: mbValue,
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'system_config',
      req,
    });

    return NextResponse.json({ success: true, maxUploadBytes: n });
  } catch (error) {
    return serverError(error, 'updating upload limit settings');
  }
}
