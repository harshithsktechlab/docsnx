import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { documents } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { canReachRecord } from '@/lib/records/handler';
import { openDocumentFile } from '@/lib/vault/vaultFiles';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * Serves a vault document's decrypted bytes.
 *
 * `documents.filePath` points here rather than at the Drive webViewLink,
 * because what sits on Drive is ciphertext — linking the UI straight to Google
 * would hand the user a file they cannot open.
 *
 * Authorisation is a primary-key lookup with an explicit tenant predicate.
 * Absent, another tenant's and soft-deleted rows all return the same 404, so
 * this cannot be used to probe for document ids.
 *
 * No Range support: GCM authenticates the whole file, so a partial read cannot
 * be verified without re-framing the ciphertext into chunks. Browsers fall back
 * to a full-body 200, which PDF viewers handle.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    const { id } = await params;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        visibleDocument()
      ),
      columns: {
        id: true,
        fileName: true,
        mimeType: true,
        filePath: true,
        categoryModuleKey: true,
        categoryDocumentKey: true,
        // Bound into the file's AAD, so the open must be told which scope the
        // bytes were sealed under. Never inferred — a wrong guess does not
        // return the wrong file, it fails to decrypt.
        companyId: true,
        fileDriveId: true,
        status: true,
      },
    });

    // Gated AFTER the lookup: since 0024 the answer depends on the record's own
    // sub-category. The query is tenant-scoped, so nothing has been revealed
    // yet, and a denied category returns the same 404 as a missing row below.
    // Absent, another tenant's, or soft-deleted all look identical from here —
    // deliberately, so this cannot be used to probe for document ids.
    if (!doc) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (!(await canReachRecord(user, 'documents', doc, 'view'))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // A row whose Drive write never completed. Distinguished from a genuine
    // 404 so an operator can tell an interrupted upload from a bad id.
    if (!doc.fileDriveId || !doc.categoryModuleKey || !doc.categoryDocumentKey) {
      if (doc.filePath && doc.filePath.startsWith('/uploads/')) {
        // Pre-vault document — the authenticated static handler still owns it.
        return NextResponse.redirect(new URL(doc.filePath, req.url));
      }
      return NextResponse.json(
        { success: false, status: 'VAULT_FILE_MISSING', message: 'This document has no stored file yet.' },
        { status: 409 }
      );
    }

    const tenant = (user as any).tenant;
    const bytes = await openDocumentFile({
      tenant: { ...tenant, id: user.tenantId },
      documentId: doc.id,
      // Both halves are bound into the file's AAD — see fileAad() in
      // vaultFiles.ts. They must match what was written, byte for byte.
      categoryKey: {
        moduleKey: doc.categoryModuleKey,
        documentKey: doc.categoryDocumentKey,
      },
      companyId: doc.companyId,
      driveFileId: doc.fileDriveId,
    });

    const contentType = doc.mimeType || 'application/octet-stream';
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      // Authed content — don't let shared caches store it.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Neutralize scripts in any HTML/SVG served from our own origin.
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    };

    // SVG can carry script — never render it inline; force download instead.
    const forceDownload =
      contentType === 'image/svg+xml' ||
      new URL(req.url).searchParams.get('download') === '1';
    if (forceDownload) {
      const safeName = (doc.fileName || 'document').replace(/["\\\r\n]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
    }

    return new NextResponse(new Uint8Array(bytes), { headers });
  } catch (error) {
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    return serverError(error, 'serving vault document');
  }
}
