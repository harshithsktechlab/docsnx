/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PLATFORM SETTINGS — a SECOND door onto the SMTP columns            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This route and /api/admin/smtp write the same six `smtp_*` columns, and until
 * now they disagreed about the password in two ways that compounded:
 *
 *   1. The GET returned `SELECT *`, so the stored `smtp_password` AND the
 *      `whatsapp_api_key` went to the browser as ciphertext.
 *   2. The PUT wrote `smtpPassword` STRAIGHT THROUGH with no `encrypt()`, while
 *      /api/admin/smtp encrypts it.
 *
 * Together those made the settings page a laundering loop: it loaded the
 * ciphertext into a form field and PUT it back verbatim. That happened to keep
 * working — `decrypt()` returns its input unchanged when the string does not
 * parse as ciphertext — which is exactly why it went unnoticed. But an admin who
 * TYPED a new password here stored a live credential in PLAINTEXT at rest,
 * against AGENTS.md §6.
 *
 * Both halves now match /api/admin/smtp: the credential is never returned, and
 * blank means "keep the stored one".
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { encrypt } from '@/lib/encryption';
import { smtpSecurityIssue } from '@/lib/smtpSecurity';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const configs = await db.select().from(systemConfigs).limit(1);
    const config = configs.length > 0 ? configs[0] : null;

    // Both stored credentials are stripped and replaced by a "is one set?"
    // flag. `SELECT *` straight into the response body put the SMTP password
    // and the WhatsApp engine key — the bearer credential for the entire
    // gateway — into every load of the settings page.
    if (!config) {
      return NextResponse.json({ success: true, config: null });
    }

    const { smtpPassword, whatsappApiKey, ...safe } = config;

    return NextResponse.json({
      success: true,
      config: {
        ...safe,
        hasSmtpPassword: !!smtpPassword,
        hasWhatsappApiKey: !!whatsappApiKey,
      },
    });
  } catch (error) {
    return serverError(error, 'fetching settings');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const body = await req.json();
    const { 
      platformName, platformGstin, platformAddress, platformStateCode, platformLogo, platformEmail, platformPhone,
      smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure, smtpFrom,
      aiCostRecordAnalysis, aiCostCategoryAnalysis, aiCostPortfolioAnalysis, aiCostBulkScan
    } = body;

    // ── THE SAME PAIRING RULE /api/admin/smtp ENFORCES ──────────────────────
    // This route writes the very columns that broke email on 2 Sep, so guarding
    // only the other door would leave the impossible combination one tab away.
    const port = parseInt(smtpPort, 10);
    const issue = Number.isFinite(port) ? smtpSecurityIssue(port, !!smtpSecure) : null;
    if (issue) {
      return NextResponse.json({ error: issue }, { status: 400 });
    }

    const configs = await db.select().from(systemConfigs).limit(1);

    // ── ENCRYPTED, AND ONLY WHEN ACTUALLY TYPED ─────────────────────────────
    // This was written straight through, unencrypted. The GET no longer sends
    // the password, so a blank field is the normal state of a save that only
    // changed the platform's GSTIN — and blanking the credential on every such
    // save would silently take email out all over again.
    const typedPassword = String(smtpPassword || '').trim();
    const passwordUpdate = typedPassword ? { smtpPassword: encrypt(typedPassword) } : {};

    if (configs.length > 0) {
      await db.update(systemConfigs)
        .set({
          platformName,
          platformGstin,
          platformAddress,
          platformStateCode,
          platformLogo,
          platformEmail,
          platformPhone,
          smtpHost,
          smtpPort: port,
          smtpUser,
          ...passwordUpdate,
          smtpSecure: !!smtpSecure,
          smtpFrom,
          updatedAt: new Date(),
          ...(aiCostRecordAnalysis !== undefined && { aiCostRecordAnalysis: String(aiCostRecordAnalysis) }),
          ...(aiCostCategoryAnalysis !== undefined && { aiCostCategoryAnalysis: String(aiCostCategoryAnalysis) }),
          ...(aiCostPortfolioAnalysis !== undefined && { aiCostPortfolioAnalysis: String(aiCostPortfolioAnalysis) }),
          ...(aiCostBulkScan !== undefined && { aiCostBulkScan: String(aiCostBulkScan) })
        })
        // `eq` is imported at the top now. An inline `require()` in an ESM
        // route handler resolves at call time on every save and defeats
        // bundling; it was also the only `require` left in src/app.
        .where(eq(systemConfigs.id, configs[0].id));
    } else {
      await db.insert(systemConfigs).values({
        platformName,
        platformGstin,
        platformAddress,
        platformStateCode,
        platformLogo,
        platformEmail,
        platformPhone,
        smtpHost,
        smtpPort: port,
        smtpUser,
        smtpPassword: encrypt(typedPassword),
        smtpSecure: !!smtpSecure,
        smtpFrom,
        ...(aiCostRecordAnalysis !== undefined && { aiCostRecordAnalysis: String(aiCostRecordAnalysis) }),
        ...(aiCostCategoryAnalysis !== undefined && { aiCostCategoryAnalysis: String(aiCostCategoryAnalysis) }),
        ...(aiCostPortfolioAnalysis !== undefined && { aiCostPortfolioAnalysis: String(aiCostPortfolioAnalysis) }),
        ...(aiCostBulkScan !== undefined && { aiCostBulkScan: String(aiCostBulkScan) })
      });
    }

    // Audited like /api/admin/smtp, and for the reason that route learned it:
    // a month passed between the mail settings being changed and anyone
    // connecting that change to the silence, and nothing in the trail said the
    // settings had been touched at all.
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.smtp.config_updated,
      details: auditSentence('config_updated', {
        kind: 'platform settings',
        note: [
          smtpHost && `SMTP ${smtpHost}:${port} (${smtpSecure ? 'implicit TLS' : 'STARTTLS'})`,
          typedPassword && 'SMTP password replaced',
        ].filter(Boolean).join(', ') || null,
      }),
      entityType: 'system_configs',
      req,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'updating settings');
  }
}
