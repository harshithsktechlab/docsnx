import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { tenantOwnsUploadedFile } from '@/lib/uploadAccess';
import { previewFailureMessage, renderForPreview } from '@/lib/records/previewRender';

/**
 * Authenticated, tenant-scoped file serving.
 * - Requires a logged-in user.
 * - The caller's tenant must own a record that references this file.
 * - Path-traversal safe; scriptable files (SVG) are neutralized.
 */
export async function GET(req, { params }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    const { filename } = await params;

    // The segment must be a bare filename (no traversal, no subpaths).
    if (
      !filename ||
      filename !== path.basename(filename) ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('\0')
    ) {
      return new NextResponse('Bad Request', { status: 400 });
    }

    // Authorization: only files owned by the caller's tenant may be served.
    const owns = await tenantOwnsUploadedFile(user.tenantId, filename);
    if (!owns) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'public', 'uploads');
    const resolvedUploadDir = path.resolve(uploadDir);
    const resolvedPath = path.resolve(path.join(uploadDir, filename));
    // Ensure the resolved path stays within the upload directory (trailing sep
    // prevents a sibling dir like `uploads-x` from matching).
    if (resolvedPath !== resolvedUploadDir && !resolvedPath.startsWith(resolvedUploadDir + path.sep)) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    if (!fs.existsSync(resolvedPath)) {
      return new NextResponse('Not Found', { status: 404 });
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    const ext = path.extname(filename).toLowerCase();

    let contentType = 'application/octet-stream';
    if (ext === '.pdf') contentType = 'application/pdf';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.webp') contentType = 'image/webp';
    else if (ext === '.svg') contentType = 'image/svg+xml';

    /**
     * `?render=1` — the same contract the vault file route offers.
     *
     * Pre-vault rows still point here, and they are the OLDEST records a tenant
     * has: a legacy .docx would otherwise be the one thing in the app that
     * still had no viewer. `renderForPreview` classifies on the filename where
     * the content type above cannot (this maps six extensions and calls
     * everything else octet-stream), which is exactly what it is built to do.
     */
    let body = fileBuffer;
    let served = contentType;
    let pageCount = 1;
    const query = new URL(req.url).searchParams;
    if (query.get('render') === '1') {
      // A legacy upload is one file on disk with no page records at all, so
      // `?page=` can only ever mean a page INSIDE it — which is what
      // `renderForPreview` does with it.
      const rendered = renderForPreview(fileBuffer, contentType, filename, {
        asImage: query.get('as') === 'image',
        page: Number(query.get('page') || '1'),
      });
      if (!rendered.ok) {
        return NextResponse.json(
          {
            success: false,
            status: 'PREVIEW_UNSUPPORTED',
            reason: rendered.reason,
            message: previewFailureMessage(rendered.reason),
          },
          { status: 415 },
        );
      }
      body = rendered.bytes;
      served = rendered.mimeType;
      if (rendered.pageCount) pageCount = rendered.pageCount;
    }

    const headers = {
      'Content-Type': served,
      'X-Preview-Page-Count': String(pageCount),
      // Authed content — don't let shared caches store it.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Neutralize scripts in any HTML/SVG served from our own origin.
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    };
    // SVG can carry script — never render it inline; force download instead.
    // `served` rather than `ext`: a rendered SVG has been flattened to a PNG,
    // which is safe to show and must not be pushed at the user as a download.
    if (served === 'image/svg+xml') {
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new NextResponse(body, { headers });
  } catch (error) {
    // Plain text rather than JSON: this route serves file bytes to an <img>
    // or an <a>, and nothing parses its error body. The reference still reaches
    // the journal, which is where a failing download has to be diagnosed.
    console.error('[route-error] serving an uploaded file:', error);
    return new NextResponse('This file could not be served.', { status: 500 });
  }
}
