import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { encrypt } from '@/lib/encryption';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * Which provider carries platform email — exactly one at a time. SMTP's own
 * fields are still saved through /api/admin/smtp; this route flips the active
 * provider and stores the Graph / Gmail settings.
 *
 * BLANK SECRET MEANS "KEEP THE STORED ONE" (same contract as the SMTP password):
 * secrets are never returned, only `hasGraphSecret` / `hasGmailKey`.
 */
const email = z.string().trim().email().max(255);
const schema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('smtp') }),
  z.object({
    provider: z.literal('graph'),
    graphTenantId: z.string().trim().min(1, 'Directory (tenant) ID is required').max(255),
    graphClientId: z.string().trim().min(1, 'Application (client) ID is required').max(255),
    graphClientSecret: z.string().optional(),
    graphSenderMailbox: email,
  }),
  z.object({
    provider: z.literal('gmail'),
    gmailClientEmail: email,
    gmailPrivateKey: z.string().optional(),
    gmailSenderMailbox: email,
  }),
]);

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const [c] = await db.select().from(systemConfigs).limit(1);
    return NextResponse.json({
      success: true,
      config: {
        provider: c?.emailProvider || 'smtp',
        smtpConfigured: !!c?.smtpHost,
        graphTenantId: c?.graphTenantId || '',
        graphClientId: c?.graphClientId || '',
        graphSenderMailbox: c?.graphSenderMailbox || '',
        hasGraphSecret: !!c?.graphClientSecret,
        gmailClientEmail: c?.gmailClientEmail || '',
        gmailSenderMailbox: c?.gmailSenderMailbox || '',
        hasGmailKey: !!c?.gmailPrivateKey,
      },
    });
  } catch (error) {
    return serverError(error, 'fetching the email provider');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid email provider settings' }, { status: 400 });
    }
    const input = parsed.data;
    const [config] = await db.select().from(systemConfigs).limit(1);

    let update: Record<string, unknown> = { emailProvider: input.provider };
    let note: string;

    if (input.provider === 'smtp') {
      if (!config?.smtpHost) {
        return NextResponse.json({ error: 'Save the SMTP settings first, then select SMTP.' }, { status: 400 });
      }
      note = 'SMTP';
    } else if (input.provider === 'graph') {
      const secret = (input.graphClientSecret || '').trim();
      if (!secret && !config?.graphClientSecret) {
        return NextResponse.json({ error: 'A client secret is required.' }, { status: 400 });
      }
      update = {
        ...update,
        graphTenantId: input.graphTenantId,
        graphClientId: input.graphClientId,
        graphSenderMailbox: input.graphSenderMailbox,
        ...(secret ? { graphClientSecret: encrypt(secret) } : {}),
      };
      note = `Microsoft Graph, sending as ${input.graphSenderMailbox}${secret ? ', secret replaced' : ''}`;
    } else {
      const key = (input.gmailPrivateKey || '').trim();
      if (!key && !config?.gmailPrivateKey) {
        return NextResponse.json({ error: 'The service account private key is required.' }, { status: 400 });
      }
      update = {
        ...update,
        gmailClientEmail: input.gmailClientEmail,
        gmailSenderMailbox: input.gmailSenderMailbox,
        ...(key ? { gmailPrivateKey: encrypt(key) } : {}),
      };
      note = `Gmail API, sending as ${input.gmailSenderMailbox}${key ? ', key replaced' : ''}`;
    }

    let id = config?.id;
    if (config) {
      await db.update(systemConfigs).set({ ...update, updatedAt: new Date() }).where(eq(systemConfigs.id, config.id));
    } else {
      // The smtp_* columns are NOT NULL, so a fresh install picking Graph/Gmail
      // first gets empty placeholders; `smtpHost: ''` reads as "SMTP unconfigured".
      const [created] = await db.insert(systemConfigs).values({
        smtpHost: '', smtpPort: 587, smtpUser: '', smtpPassword: '', smtpSecure: false, smtpFrom: '',
        ...update,
      } as typeof systemConfigs.$inferInsert).returning();
      id = created?.id;
    }

    // Names the provider and mailbox — never a credential.
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.smtp.config_updated,
      details: auditSentence('config_updated', { kind: 'Email provider', note }),
      entityType: 'system_configs',
      entityId: id,
      req,
    });

    return NextResponse.json({ success: true, provider: input.provider });
  } catch (error) {
    return serverError(error, 'updating the email provider');
  }
}
