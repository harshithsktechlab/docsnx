import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { encrypt } from '@/lib/encryption';
import { smtpSecurityIssue } from '@/lib/smtpSecurity';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';


export const dynamic = 'force-dynamic';

/**
 * The shape, checked rather than assumed.
 *
 * This route used to destructure raw JSON and `parseInt` an unchecked value, so
 * a missing port became `NaN` and went into a `notNull` integer column — the
 * kind of write that fails at the database with an error nobody can read back
 * to a setting.
 */
const smtpSchema = z.object({
  smtpHost: z.string().trim().min(1, 'An SMTP host is required').max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpUser: z.string().trim().min(1, 'An SMTP username is required').max(255),
  /**
   * BLANK MEANS "KEEP THE STORED PASSWORD". The GET below never hands the
   * password to the browser, so the form has nothing to send back — an empty
   * string is what a save looks like when the admin only changed the port.
   * Same contract as `apiKey` in /api/admin/whatsapp.
   */
  smtpPassword: z.string().optional(),
  smtpSecure: z.boolean(),
  smtpFrom: z.string().trim().email('The From address must be a valid email').max(255),
});

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [config] = await db.select().from(systemConfigs).limit(1);
    if (!config) {
      // 587 + secure:FALSE, and the pairing matters more than either value.
      //
      // This fallback used to read `smtpSecure: true` beside port 587, which is
      // implicit TLS aimed at a STARTTLS port and cannot connect to anything.
      // A fresh install was therefore born holding the one combination
      // `smtpSecurityIssue` now refuses — and since nothing validated it, the
      // operator's only symptom was mail that never arrived.
      return NextResponse.json({
        success: true,
        config: { smtpHost: '', smtpPort: 587, smtpUser: '', smtpSecure: false, smtpFrom: '', hasPassword: false }
      });
    }

    // ── `hasPassword`, NEVER THE PASSWORD ───────────────────────────────────
    // This used to DECRYPT the stored credential and send the plaintext to the
    // browser, so the live SMTP password sat in a response body, in the network
    // log, and in the page's memory for as long as the tab was open. Only a
    // SUPER_ADMIN can reach it, which bounds who can read it — it does not make
    // it a thing to hand out. Nothing in the UI needs to read it back: a form
    // needs to know whether one is stored, and that is all this says.
    //
    // Mirrors `hasApiKey` in /api/admin/whatsapp, which already answers exactly
    // this question about the other credential in the same row.
    return NextResponse.json({
      success: true,
      config: {
        id: config.id,
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        smtpUser: config.smtpUser,
        hasPassword: !!config.smtpPassword,
        smtpSecure: config.smtpSecure,
        smtpFrom: config.smtpFrom
      }
    });
  } catch (error) {
    return serverError(error, 'fetching SMTP config');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = smtpSchema.safeParse(await req.json());
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return NextResponse.json({ error: firstIssue?.message || 'Invalid SMTP settings' }, { status: 400 });
    }

    const { smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure, smtpFrom } = parsed.data;

    // ── THE PORT AND THE TLS MODE ARE ONE SETTING ───────────────────────────
    // Refusing the impossible pair here rather than only warning in the form:
    // the form can be bypassed, and this exact combination (587 + secure) is
    // what silently took the whole email channel out on 2 Sep. A configuration
    // that cannot connect must not be storable.
    const issue = smtpSecurityIssue(smtpPort, smtpSecure);
    if (issue) {
      return NextResponse.json({ error: issue }, { status: 400 });
    }

    const typedPassword = (smtpPassword || '').trim();

    let [config] = await db.select().from(systemConfigs).limit(1);

    // Creating the row: there is no stored password to fall back on, so a blank
    // one would write an empty credential and every send would fail on auth.
    if (!config && !typedPassword) {
      return NextResponse.json({ error: 'An SMTP password is required.' }, { status: 400 });
    }

    if (config) {
      const [updated] = await db.update(systemConfigs).set({
        smtpHost,
        smtpPort,
        smtpUser,
        // Only overwrite when a new one was actually typed. Without this, every
        // save from a form that no longer receives the password would blank the
        // credential — which is the failure the masking would otherwise cause.
        ...(typedPassword ? { smtpPassword: encrypt(typedPassword) } : {}),
        smtpSecure,
        smtpFrom,
        updatedAt: new Date(),
      }).where(eq(systemConfigs.id, config.id)).returning();
      config = updated;
    } else {
      const [created] = await db.insert(systemConfigs).values({
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPassword: encrypt(typedPassword),
        smtpSecure,
        smtpFrom
      }).returning();
      config = created;
    }

    // Names the host, port and TLS mode — never the credentials. The gap
    // between "someone changed the mail settings" and "mail stopped arriving"
    // is precisely what had no record last time.
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.smtp.config_updated,
      details: auditSentence('config_updated', {
        kind: 'SMTP configuration',
        note: [
          `${smtpHost}:${smtpPort} (${smtpSecure ? 'implicit TLS' : 'STARTTLS'})`,
          `from ${smtpFrom}`,
          typedPassword && 'password replaced',
        ].filter(Boolean).join(', '),
      }),
      entityType: 'system_configs',
      entityId: config?.id,
      req,
    });

    // The same shape GET answers with, and for the same reason: `config` is the
    // whole `system_configs` row, so returning it verbatim would hand back the
    // stored `smtp_password` AND the `whatsapp_api_key` as ciphertext — undoing
    // on the write path what the GET above stopped doing on the read path.
    return NextResponse.json({
      success: true,
      config: {
        id: config?.id,
        smtpHost, smtpPort, smtpUser, smtpSecure, smtpFrom,
        hasPassword: !!config?.smtpPassword,
      },
    });
  } catch (error) {
    return serverError(error, 'updating SMTP config');
  }
}
