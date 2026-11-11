import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import {
  setMaxUploadBytes,
  setScanLimits,
  DEFAULT_MAX_UPLOAD_BYTES,
  UPLOAD_LIMIT_CEILING_BYTES,
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_MAX_SCAN_PAGES,
  DEFAULT_MAX_SCAN_BYTES,
  SCAN_FILES_CEILING,
  SCAN_PAGES_CEILING,
} from '@/lib/records/uploadTypes';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const [config] = await db.select({
      maxUploadBytes: systemConfigs.maxUploadBytes,
      maxScanFiles: systemConfigs.maxScanFiles,
      maxScanPages: systemConfigs.maxScanPages,
      maxScanBytes: systemConfigs.maxScanBytes,
    }).from(systemConfigs).limit(1);

    return NextResponse.json({
      success: true,
      maxUploadBytes: config?.maxUploadBytes ?? null,
      defaultMaxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      ceilingBytes: UPLOAD_LIMIT_CEILING_BYTES,
      maxScanFiles: config?.maxScanFiles ?? null,
      maxScanPages: config?.maxScanPages ?? null,
      maxScanBytes: config?.maxScanBytes ?? null,
      scanDefaults: {
        files: DEFAULT_MAX_SCAN_FILES,
        pages: DEFAULT_MAX_SCAN_PAGES,
        bytes: DEFAULT_MAX_SCAN_BYTES,
      },
      scanCeilings: {
        files: SCAN_FILES_CEILING,
        pages: SCAN_PAGES_CEILING,
        bytes: UPLOAD_LIMIT_CEILING_BYTES,
      },
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

    /**
     * Bulk Scan limits. Each is optional and independent: a key that is ABSENT
     * leaves its column alone (so a caller that only knows `maxUploadBytes`
     * cannot wipe them), and an explicit `null` resets it to the built-in default.
     */
    const scanFields = [
      { key: 'maxScanFiles', label: 'Files per scan', ceiling: SCAN_FILES_CEILING, unit: 'files' },
      { key: 'maxScanPages', label: 'Pages per scan', ceiling: SCAN_PAGES_CEILING, unit: 'pages' },
      { key: 'maxScanBytes', label: 'Total size per scan', ceiling: UPLOAD_LIMIT_CEILING_BYTES, unit: 'bytes' },
    ] as const;
    const scanUpdate: Record<string, number | null> = {};
    for (const f of scanFields) {
      const raw = body[f.key];
      if (raw === undefined) continue;
      if (raw === null) { scanUpdate[f.key] = null; continue; }
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 1) {
        return NextResponse.json(
          { error: `${f.label} must be a whole number of at least 1.` },
          { status: 400 },
        );
      }
      if (v > f.ceiling) {
        const shown = f.unit === 'bytes' ? `${f.ceiling / (1024 * 1024)} MB` : `${f.ceiling} ${f.unit}`;
        return NextResponse.json(
          { error: `${f.label} cannot exceed ${shown}.` },
          { status: 400 },
        );
      }
      scanUpdate[f.key] = v;
    }

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
      .set({ maxUploadBytes: n, ...scanUpdate, updatedAt: new Date() })
      .where(eq(systemConfigs.id, config.id));

    setMaxUploadBytes(n);
    if (Object.keys(scanUpdate).length > 0) {
      const [fresh] = await db.select({
        maxScanFiles: systemConfigs.maxScanFiles,
        maxScanPages: systemConfigs.maxScanPages,
        maxScanBytes: systemConfigs.maxScanBytes,
      }).from(systemConfigs).where(eq(systemConfigs.id, config.id));
      setScanLimits(fresh);
    }

    const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
    const mbValue = n !== null ? mb(n) : `default (${mb(DEFAULT_MAX_UPLOAD_BYTES)})`;
    const scanNote = Object.keys(scanUpdate).length === 0
      ? ''
      : `; scan limits: ${[
          'maxScanFiles' in scanUpdate ? `files ${scanUpdate.maxScanFiles ?? `default (${DEFAULT_MAX_SCAN_FILES})`}` : null,
          'maxScanPages' in scanUpdate ? `pages ${scanUpdate.maxScanPages ?? `default (${DEFAULT_MAX_SCAN_PAGES})`}` : null,
          'maxScanBytes' in scanUpdate
            ? `size ${scanUpdate.maxScanBytes !== null ? mb(scanUpdate.maxScanBytes as number) : `default (${mb(DEFAULT_MAX_SCAN_BYTES)})`}`
            : null,
        ].filter(Boolean).join(', ')}`;
    await writeAudit({
      action: ACTIONS.system_config.upload_limit_updated,
      details: auditSentence('update', {
        kind: 'upload limit',
        note: `${mbValue}${scanNote}`,
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'system_config',
      req,
    });

    return NextResponse.json({ success: true, maxUploadBytes: n, ...scanUpdate });
  } catch (error) {
    return serverError(error, 'updating upload limit settings');
  }
}
