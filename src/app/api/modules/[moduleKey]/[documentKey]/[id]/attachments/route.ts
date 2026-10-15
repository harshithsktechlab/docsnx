/**
 * A record's photo attachments (0069) — add one, remove one.
 *
 * Reading them is not here: the bytes are served by the one file route every
 * module uses (`/api/records/:scope/:id/file?attachment=<id>`), behind the same
 * view / company / share gates as the record's own document, and the list of
 * them arrives with the record itself (`attachments` on the projection).
 *
 * Only categories with an ATTACHMENT_SLOT accept photos — see
 * src/lib/records/recordAttachments.ts.
 */
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { withCategory } from '@/lib/records/handler';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { attachmentSlotFor, isAttachmentId } from '@/lib/records/recordAttachments';
import {
  AttachmentLimitError, addRecordAttachment, removeRecordAttachment,
} from '@/lib/vault/vaultAttachments';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse } from '@/lib/uploadErrors';
import { checkStorageLimit } from '@/lib/storage';
import { writeAudit } from '@/lib/audit';
import { auditSentence, categoryPhrase, recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ moduleKey: string; documentKey: string; id: string }> };

/** The thumbnail the browser makes is small; anything bigger was not made by it. */
const THUMB_MAX_BYTES = 512 * 1024;

function fail(error: unknown): Response {
  if (error instanceof AttachmentLimitError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const vault = vaultErrorResponse(error);
  if (vault) return vault;
  const reauth = driveReauthResponse(error);
  if (reauth) return reauth;
  return serverError(error, 'saving a record photo');
}

/**
 * The record, as THIS workspace and THIS category hold it. Absent, another
 * tenant's, another workspace's, another category's and deleted all read as
 * null — the 404 must not tell them apart.
 */
async function ownedRecord(
  tenantId: string,
  companyId: string | null,
  id: string,
  key: { moduleKey: string; documentKey: string },
) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await withTenant(tenantId, (tx) => tx
    .select({
      id: documents.id,
      title: documents.title,
      userId: documents.userId,
      companyId: documents.companyId,
    })
    .from(documents)
    .where(and(
      eq(documents.id, id),
      eq(documents.tenantId, tenantId),
      companyId ? eq(documents.companyId, companyId) : sql`${documents.companyId} is null`,
      eq(documents.categoryModuleKey, key.moduleKey),
      eq(documents.categoryDocumentKey, key.documentKey),
      visibleDocument(),
    ))
    .limit(1));
  return row ?? null;
}

export async function POST(req: Request, { params }: Params) {
  const { moduleKey, documentKey, id } = await params;
  const categoryKey = canonicalCategory({ moduleKey, documentKey });
  const slot = attachmentSlotFor(categoryKey);
  if (!slot) return NextResponse.json({ error: 'This category does not take photos' }, { status: 400 });

  return withCategory(req, categoryKey, 'edit', async (ctx) => {
    try {
      const record = await ownedRecord(ctx.user.tenantId, ctx.companyId, id, categoryKey);
      if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const form = await req.formData();
      const photo = form.get('photo');
      const thumb = form.get('thumb');
      if (!(photo instanceof File) || photo.size === 0) {
        return NextResponse.json({ error: 'No photo was sent' }, { status: 400 });
      }
      if (!slot.accept.includes(photo.type)) {
        return NextResponse.json({ error: 'Photos must be JPEG, PNG or WebP images' }, { status: 400 });
      }
      if (photo.size > slot.maxBytes) {
        return NextResponse.json({ error: 'That photo is too large' }, { status: 413 });
      }
      const thumbFile = thumb instanceof File && thumb.size > 0
        && thumb.type === 'image/jpeg' && thumb.size <= THUMB_MAX_BYTES
        ? thumb : null;

      const bytes = photo.size + (thumbFile?.size ?? 0);
      const quota = await checkStorageLimit(ctx.user.tenantId, bytes);
      if (!quota.allowed) {
        return NextResponse.json({ error: quota.error || 'Storage limit reached' }, { status: 413 });
      }

      const entry = await addRecordAttachment(
        {
          tenant: { ...ctx.user.tenant, id: ctx.user.tenantId },
          tenantId: ctx.user.tenantId,
          // The RECORD's company, off its row.
          companyId: record.companyId ?? null,
          actorUserId: ctx.user.id,
          ownerId: record.userId,
          recordId: record.id,
          categoryKey,
        },
        slot,
        { bytes: Buffer.from(await photo.arrayBuffer()), mimeType: photo.type, name: photo.name || 'photo' },
        thumbFile ? { bytes: Buffer.from(await thumbFile.arrayBuffer()) } : null,
      );

      await withTenant(ctx.user.tenantId, (tx) => tx
        .update(documents)
        .set({ attachmentSize: sql`${documents.attachmentSize} + ${bytes}`, updatedAt: new Date() })
        .where(and(eq(documents.id, record.id), eq(documents.tenantId, ctx.user.tenantId))));

      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        companyId: ctx.companyId,
        action: recordAction(ctx.scope, 'update'),
        details: auditSentence('update', {
          kind: 'document',
          name: record.title,
          category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
          note: 'added a photo',
        }),
        req,
      });

      return NextResponse.json({
        success: true,
        attachment: {
          id: entry.id,
          kind: entry.kind,
          mimeType: entry.mimeType,
          size: entry.size,
          name: entry.name,
          hasThumb: Boolean(entry.thumb),
          createdAt: entry.createdAt,
        },
      });
    } catch (error) {
      return fail(error);
    }
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const { moduleKey, documentKey, id } = await params;
  const categoryKey = canonicalCategory({ moduleKey, documentKey });
  if (!attachmentSlotFor(categoryKey)) {
    return NextResponse.json({ error: 'This category does not take photos' }, { status: 400 });
  }
  const attachmentId = new URL(req.url).searchParams.get('attachmentId');
  if (!isAttachmentId(attachmentId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return withCategory(req, categoryKey, 'edit', async (ctx) => {
    try {
      const record = await ownedRecord(ctx.user.tenantId, ctx.companyId, id, categoryKey);
      if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const removed = await removeRecordAttachment(
        {
          tenant: { ...ctx.user.tenant, id: ctx.user.tenantId },
          tenantId: ctx.user.tenantId,
          companyId: record.companyId ?? null,
          actorUserId: ctx.user.id,
          ownerId: record.userId,
          recordId: record.id,
          categoryKey,
        },
        attachmentId,
      );
      if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const bytes = removed.size + (removed.thumb?.size ?? 0);
      await withTenant(ctx.user.tenantId, (tx) => tx
        .update(documents)
        // Clamped: a row written before its photos were counted must not go negative.
        .set({ attachmentSize: sql`greatest(${documents.attachmentSize} - ${bytes}, 0)`, updatedAt: new Date() })
        .where(and(eq(documents.id, record.id), eq(documents.tenantId, ctx.user.tenantId))));

      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        companyId: ctx.companyId,
        action: recordAction(ctx.scope, 'update'),
        details: auditSentence('update', {
          kind: 'document',
          name: record.title,
          category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
          note: 'removed a photo',
        }),
        req,
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      return fail(error);
    }
  });
}
