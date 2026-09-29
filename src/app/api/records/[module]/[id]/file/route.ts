import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPermission } from '@/lib/auth';
import { openDocumentFile } from '@/lib/vault/vaultFiles';
import { readRecord } from '@/lib/vault/vaultRecords';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { isRecordScope, recordScopeConfig } from '@/lib/records/registry';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { previewFailureMessage, renderForPreview } from '@/lib/records/previewRender';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * Serves a vault record's decrypted bytes, for every module.
 *
 * `filePath` on every record points here rather than at the Drive webViewLink,
 * because what sits on Drive is ciphertext — linking the UI straight to Google
 * would hand the user a file they cannot open. One route serves all modules, so
 * the hardening below is written once instead of twelve times.
 *
 * Authorisation is a primary-key lookup with an explicit tenant predicate,
 * which is stronger than the filename UNION across twelve tables that
 * `tenantOwnsUploadedFile` performs for legacy /uploads/* paths.
 *
 * No Range support: GCM authenticates the whole file, so a partial read cannot
 * be verified without re-framing the ciphertext into chunks. Browsers fall back
 * to a full-body 200, which PDF viewers handle.
 */

/**
 * There is no module → table map any more.
 *
 * Every module's records are rows of `documents`, distinguished by
 * `category_module_key` — which since migration 0015 IS the module name AND the
 * permission key. The twelve-entry table this replaced also had to state that
 * `rentals` records lived in `contract_agreements`; that whole class of mapping
 * is gone.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ module: string; id: string }> }
) {
  try {
    const { module: moduleParam, id } = await params;

    // Allowlisted before anything else — the module segment is user-controlled
    // and selects a database table.
    if (!isRecordScope(moduleParam)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [record] = await withTenant(user.tenantId, (tx) => tx
      .select({
        id: documents.id,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        filePath: documents.filePath,
        categoryModuleKey: documents.categoryModuleKey,
        categoryDocumentKey: documents.categoryDocumentKey,
        // Bound into the AAD of both the bytes and the JSON store, so every
        // read below has to be told which scope sealed them.
        companyId: documents.companyId,
        fileDriveId: documents.fileDriveId,
      })
      .from(documents)
      .where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        visibleDocument(),
      ))
      .limit(1)) as any[];

    // Absent, another tenant's, and soft-deleted all look identical from here —
    // deliberately, so this cannot be used to probe for record ids.
    if (!record) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    /**
     * Authorised against the record's OWN category, not the scope in the URL.
     *
     * Permission has never been a property of the page — `hasPermission` takes
     * the taxonomy module and the sub-category, so a member denied "Bank locker
     * agreement" is denied it on whichever page they reach it from, and a member
     * allowed it is allowed it likewise. Filtering the row by the URL scope's
     * categories added nothing to that and broke reads instead: `file_path` is
     * minted from the scope that WROTE the record, which since 0023 need not be
     * the scope that owns its category. A scan filed from the Document Manager
     * into `property_legal/will_nomination` stored
     * `/api/records/documents/<id>/file`, and `documents` owns identity,
     * education, civil_government and other — so the row fell outside the
     * predicate and a perfectly intact file answered 404. Two of production's
     * five vault-backed records were unreachable for exactly this reason.
     *
     * `isRecordScope` above still rejects a nonsense segment, so the URL shape
     * is unchanged; the segment simply no longer decides who may read what.
     *
     * 404 rather than 403 on a denial, matching the block above: whether a
     * record exists is itself information a denied member should not get.
     */
    const recordModule =
      record.categoryModuleKey ?? recordScopeConfig(moduleParam).primaryModule;
    const permitted = await hasPermission(
      user,
      recordModule,
      'view',
      record.categoryDocumentKey ?? undefined,
    );
    if (!permitted) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    /**
     * A COMPANY's bytes need the company, not merely the module.
     *
     * `hasPermission` above answers about the taxonomy — may this member read
     * `biz_registration/pan_card` at all — and every other route that reaches a
     * company record asks a second question after it: is this member on THIS
     * company's `company_access`. This route did not, because it resolves the
     * row by `(id, tenantId)` and takes `companyId` off the row rather than
     * from the request, so there was no untrusted id to gate and the gate was
     * never written. The trust argument does not carry: the id is still an id
     * the caller supplied, and a tenant member holding the business modules by
     * default could fetch any company's file by addressing it directly.
     *
     * 404, matching the permission denial above rather than the 403 the
     * download gate below uses: whether a company has a record is itself
     * something a member outside that company should not be able to probe for.
     */
    if (record.companyId && !await hasCompanyAccess(user, record.companyId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    /**
     * Taking a COPY out is a different act from reading it here.
     *
     * `view` gates the bytes, above. `?download=1` asks for them as an
     * attachment — the Download button, `bulk-download`, anything that ends
     * with a file on the member's disk — and that is what `canShare` governs:
     * a member granted View only on Identity can open their passport in the
     * app and cannot walk away with the file.
     *
     * 403, not the 404 the view denial uses. There the existence of the record
     * is itself withheld; here the member is already allowed to know it exists
     * and is looking at it, so a 404 would be a confusing lie rather than a
     * defence.
     *
     * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────
     * It is not a seal. Anyone who can preview can already fetch these bytes —
     * that is the same request without the parameter — so this stops the
     * button and every ordinary route to a saved copy, not a determined member
     * with the network tab open. Closing that would mean denying preview to
     * view-only members, which is not what "view" is supposed to mean. The
     * `sw.js` offline cache is subject to the same limit.
     *
     * Deliberately keyed to the EXPLICIT parameter and not to `forceDownload`
     * below: an SVG is sent as an attachment for script-safety reasons of our
     * own, and gating that would break previewing an SVG on `view`.
     */
    const wantsDownload = new URL(req.url).searchParams.get('download') === '1';
    /**
     * `?render=1` — give me a form of this document a BROWSER can show.
     *
     * Gated on `view`, which it already has: converting a .docx to a PDF so it
     * can be looked at is not taking a copy out, and that is the only thing the
     * `share` gate above governs. A view-only member could previously neither
     * view an office document nor download it, which made "view" mean nothing
     * for twelve of the eighteen types the vault accepts.
     *
     * `download` wins where both are asked for: a saved copy should be the
     * original file, not a rendering of it.
     */
    const wantsRender = !wantsDownload
      && new URL(req.url).searchParams.get('render') === '1';
    /**
     * `&as=image` — and I cannot draw a PDF.
     *
     * Which is every phone. No mobile browser frames a PDF: Android Chrome has
     * never carried the desktop viewer plugin and puts an "open / download" bar
     * in its place, and inside an installed PWA that bar goes nowhere, because
     * its target is a `blob:` URL the app has nothing registered to open. So
     * the whole point of `render=1` — that a .docx becomes a PDF — landed on
     * mobile as an empty box.
     *
     * The client asks for this, rather than the server sniffing a user agent:
     * `navigator.pdfViewerEnabled` is the browser's own answer to exactly this
     * question, and it is right about a desktop with the viewer disabled by
     * policy too.
     */
    const wantsImage = wantsRender
      && new URL(req.url).searchParams.get('as') === 'image';
    if (wantsDownload) {
      const mayDownload = await hasPermission(
        user,
        recordModule,
        'share',
        record.categoryDocumentKey ?? undefined,
      );
      if (!mayDownload) {
        return NextResponse.json(
          { error: 'You do not have permission to download this document.' },
          { status: 403 },
        );
      }
    }

    if (!record.fileDriveId || !record.categoryModuleKey || !record.categoryDocumentKey) {
      // Pre-vault row — the authenticated static handler still owns those.
      if (record.filePath && String(record.filePath).startsWith('/uploads/')) {
        return NextResponse.redirect(new URL(record.filePath, req.url));
      }
      return NextResponse.json(
        {
          success: false,
          status: 'VAULT_FILE_MISSING',
          message: 'This record has no stored file yet.',
        },
        { status: 409 }
      );
    }

    // `?page=` selects one page of a multi-page record. Without it the first
    // page is served, which is what every existing link expects.
    const requestedPage = Number(new URL(req.url).searchParams.get('page') || '1');

    const tenant = (user as any).tenant;
    const ctx = { tenant: { ...tenant, id: user.tenantId }, tenantId: user.tenantId, userId: user.id };
    const categoryKey = {
      moduleKey: record.categoryModuleKey,
      documentKey: record.categoryDocumentKey,
    };

    /**
     * The JSON store lives under the CATEGORY's module — NOT the scope in the
     * URL. `storeRecordInVault` writes it that way (a scope can span two
     * modules, and a property_legal record has no store under bank_investments),
     * so a read under anything else finds no pointer at all.
     *
     * This line used to pass `moduleParam`, the scope. Scope and taxonomy module
     * share a name for only two of the fifteen scopes, so for the other
     * thirteen — `rentals` vs `rentals_subscriptions`, `medical` vs
     * `health_medical` — the lookup missed, `fileId` fell back to null, and
     * `openDocumentFile` then built its AAD from the document id where the seal
     * had used the page's own id. The result was VAULT_DECRYPT_FAILED on
     * ciphertext that was written perfectly well: every module's file viewer,
     * including the Document Manager's. `bulk-download` already read it
     * correctly, which is why that path kept working.
     */
    const vaultModule = record.categoryModuleKey;

    // A record's pages live in its Drive JSON, each with its own object id and
    // its own `fileId` — which is part of that page's AAD, so opening page two
    // with page one's id fails rather than returning the wrong bytes.
    //
    // NOT swallowed with a `.catch`: an unreadable store means the id this file
    // is sealed against cannot be recovered, and going on to decrypt without it
    // produces an integrity failure that reads like data corruption.
    // `vaultErrorResponse` reports the real cause instead.
    const stored = await readRecord<any>(
      { ...(ctx as any), companyId: record.companyId }, vaultModule as any, categoryKey, record.id);
    const storedPages: any[] = stored?.pages ?? [];

    /**
     * ╔════════════════════════════════════════════════════════════════════╗
     * ║   WHAT `?page=N` MEANS depends on how the record was stored        ║
     * ╚════════════════════════════════════════════════════════════════════╝
     *
     * The vault holds two shapes, both of them real and both in production:
     *
     *  · SPLIT — a scan rasterised at upload, one Drive object per sheet. Here
     *    page N is Drive object N, which is what this route has always done.
     *
     *  · UNSPLIT — one PDF stored whole. The vault records ONE page however
     *    many sheets are inside it, so asking for page 3 used to 404 on a
     *    perfectly good ten-page agreement, and the pager never appeared at all
     *    because `pageCount` said 1.
     *
     * So: the store decides. More than one stored page means N selects the
     * object; exactly one means N selects a page INSIDE it, which only the
     * rasteriser below can do — and it reports the true count back so the
     * client's pager stops lying.
     */
    const splitAcrossObjects = storedPages.length > 1;
    const vaultPage = splitAcrossObjects ? requestedPage : 1;
    const pdfPage = splitAcrossObjects ? 1 : requestedPage;

    let driveFileId: string = record.fileDriveId;
    let fileId: string | null = null;
    let pageMime: string | null = null;

    const selected = storedPages.find((pg: any) => pg.page === vaultPage);
    if (vaultPage > 1) {
      if (!selected) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
      driveFileId = selected.driveFileId;
    }
    // Page one carries its own `fileId` too — every upload assigns one, even a
    // single unsplit file.
    if (selected) {
      fileId = selected.fileId ?? null;
      pageMime = selected.mimeType ?? null;
    }

    const bytes = await openDocumentFile({
      tenant: { ...tenant, id: user.tenantId },
      documentId: record.id,
      companyId: record.companyId,
      categoryKey,
      driveFileId,
      fileId,
    });

    let contentType = pageMime || record.mimeType || 'application/octet-stream';
    let body = bytes;
    /**
     * How many pages the client's pager should offer.
     *
     * The stored page count by default, and the RENDERED one where rasterising
     * found more inside a single stored PDF — which is the only way that number
     * can be known, and the reason an unsplit multi-page document never paged.
     */
    let pageCount = Math.max(1, storedPages.length);

    if (wantsRender) {
      // The PAGE's mime, not the record's column: a PDF stored split is
      // `image/jpeg` pages under an `application/pdf` record, and only the
      // first of those describes the bytes actually in hand.
      const rendered = renderForPreview(bytes, contentType, record.fileName, {
        asImage: wantsImage,
        page: pdfPage,
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
      contentType = rendered.mimeType;
      if (!splitAcrossObjects && rendered.pageCount) pageCount = rendered.pageCount;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      // Same-origin, so the client reads this without any CORS exposure list.
      'X-Preview-Page-Count': String(pageCount),
      // Authed content — don't let shared caches store it.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Neutralize scripts in any HTML/SVG served from our own origin.
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    };

    // SVG can carry script — never render it inline; force download instead.
    // `wantsDownload` has already been gated on `share` above. `contentType` is
    // the RENDERED type when `render=1` ran, and the renderer flattens an SVG
    // into a PNG precisely so it can be looked at safely, so that path is never
    // still `image/svg+xml` here.
    const forceDownload = contentType === 'image/svg+xml' || wantsDownload;
    if (forceDownload) {
      const safeName = String(record.fileName || 'file').replace(/["\\\r\n]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
    }

    return new NextResponse(new Uint8Array(body), { headers });
  } catch (error) {
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    return serverError(error, 'serving vault record');
  }
}
