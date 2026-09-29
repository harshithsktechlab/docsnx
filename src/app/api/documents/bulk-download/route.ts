/**
 * Download several documents as one ZIP.
 *
 * The alternative — the browser fetching N files in a loop — asks the user to
 * approve N downloads and gets throttled past a handful. This is one request
 * and one saved file.
 *
 * ── DECRYPTION IS SERVER-SIDE, ALWAYS ──────────────────────────────────────
 * Each entry goes through `openDocumentFile`, the same call
 * `/api/records/[module]/[id]/file` uses, so the AAD binding and key-version
 * handling are not reimplemented here. What sits on Drive is ciphertext and no
 * Drive id or link is ever handed to the client — the ZIP contains plaintext
 * that this process decrypted and streamed.
 *
 * ── ONE BAD ENTRY MUST NOT LOSE THE REST ───────────────────────────────────
 * A selection of forty documents should not fail because one has a missing
 * Drive object. Failures are collected into an `_errors.txt` member and the
 * archive is still delivered — the user gets thirty-nine files and a plain
 * statement of what did not come through.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ZipArchive } from 'archiver';
import { Readable } from 'stream';
import { withTenant } from '@/lib/db';
import { documents, users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { categoryIdIn, permittedCategories } from '@/lib/records/handler';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { keysForWorkspace } from '@/lib/documentCategories';
import { openDocumentFile } from '@/lib/vault/vaultFiles';
import { readRecord } from '@/lib/vault/vaultRecords';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '@/lib/audit';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * A filename that is safe inside a ZIP and on the extracting filesystem.
 *
 * Path separators and `..` are stripped, not escaped: a stored `fileName` is
 * user-supplied, and an entry named `../../x` is a zip-slip that writes outside
 * the extraction directory on a careless extractor.
 */
function safeEntryName(name: string | null, fallback: string): string {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || fallback;
}

/** Two documents may share a filename; the ZIP entries may not. */
function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (taken.has(`${stem} (${n})${ext}`)) n += 1;
  const out = `${stem} (${n})${ext}`;
  taken.add(out);
  return out;
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // "Any category at all" opens the endpoint; the selection is then filtered
    // to the categories this member may actually take a copy out of, so a
    // denied document cannot be pulled out inside a zip of permitted ones.
    //
    // `share`, not `view`: this endpoint's whole output is a file on the
    // member's disk, which is what `share` governs — the same rule the single
    // download enforces at records/[module]/[id]/file. Gating it on `view`
    // would leave the bulk path as a way around the single one.
    /**
     * ── THIS ROUTE HAD NO COMPANY AXIS AT ALL ──────────────────────────────
     *
     * It selected by id + tenant + permitted category, so a member who could
     * share a `biz_*` category could export ANY company's files in the tenant by
     * naming their ids — `hasCompanyAccess` was never consulted. The category
     * permission is a different axis from company access and does not stand in
     * for it.
     *
     * Now the workspace is proven first and the query is scoped to it, like
     * every other list on this page.
     */
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;
    const { companyId } = scope;

    const downloadable = keysForWorkspace(await permittedCategories(user, 'share'), companyId);
    if (downloadable.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const ids = [...new Set(parsed.data.ids)];

    // Resolved before the transaction because it is async — it asks the taxonomy
    // registry how many categories exist, to decide whether `downloadable` is
    // the whole of it. The withTenant callback stays synchronous.
    const downloadableFilter = await categoryIdIn(downloadable);

    // The tenant predicate is what confines this, not the id list. Another
    // tenant's id simply selects no row.
    const rows = await withTenant(user.tenantId, (tx) =>
      tx.select({
        id: documents.id,
        title: documents.title,
        fileName: documents.fileName,
        categoryModuleKey: documents.categoryModuleKey,
        categoryDocumentKey: documents.categoryDocumentKey,
        companyId: documents.companyId,
        // The member each document is filed under, for its audit line. Joined
        // here rather than looked up per row: an export of forty documents
        // would otherwise be forty extra queries to write forty lines.
        holderName: users.name,
        fileDriveId: documents.fileDriveId,
      })
        .from(documents)
        .leftJoin(users, eq(users.id, documents.holderId))
        .where(and(
          inArray(documents.id, ids),
          eq(documents.tenantId, user.tenantId),
          inCompanyOf(documents.companyId, companyId),
          downloadableFilter,
          visibleDocument(),
        )),
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No documents found' }, { status: 404 });
    }

    const tenant = { ...(user as any).tenant, id: user.tenantId };
    const ctx = { tenant, tenantId: user.tenantId, userId: user.id };

    // archiver v8 is ESM-only and exports CLASSES — there is no callable
    // `archiver('zip', …)` default any more, and importing one only warns at
    // build time before failing at runtime.
    const archive = new ZipArchive({
      // JPEG and PDF are already compressed, and this archive is built from
      // decrypted bytes held in memory — spending CPU to shrink it by a percent
      // is the wrong trade.
      zlib: { level: 1 },
    });

    // A Transform stream with no error listener throws unhandled and kills the
    // response mid-flight. Archiver signals a skipped entry as 'warning'.
    archive.on('warning', (err) => console.warn('Bulk download archive warning:', err));
    archive.on('error', (err) => console.error('Bulk download archive error:', err));
    const errors: string[] = [];
    const taken = new Set<string>();
    /**
     * The documents whose bytes actually reached the archive — what the audit
     * trail reports.
     *
     * NOT `rows`, which is what was SELECTED. An entry with no stored file, or
     * one whose Drive object cannot be decrypted, is skipped into `errors` and
     * never leaves the vault; counting it as downloaded overstates the export,
     * which is the one thing this log exists to get right.
     */
    const exported: typeof rows = [];

    // Built before streaming starts so a Drive failure surfaces as an entry in
    // `_errors.txt` rather than as a truncated download the user cannot tell
    // apart from a network drop.
    for (const row of rows) {
      const entryName = uniqueName(taken, safeEntryName(row.fileName, `${row.title || row.id}.bin`));

      if (!row.fileDriveId || !row.categoryModuleKey || !row.categoryDocumentKey) {
        errors.push(`${row.title}: no stored file`);
        continue;
      }

      const categoryKey = {
        moduleKey: row.categoryModuleKey,
        documentKey: row.categoryDocumentKey,
      };

      try {
        // Page one carries its own `fileId` when the record was written with
        // pages, and that id is part of the AAD — opening without it fails.
        const stored: any = await readRecord(
          ctx as any, row.categoryModuleKey as any, categoryKey, row.id,
        ).catch(() => null);
        const first = (stored?.pages ?? []).find((pg: any) => pg.page === 1);

        const bytes = await openDocumentFile({
          tenant,
          documentId: row.id,
          companyId: row.companyId,
          categoryKey,
          driveFileId: row.fileDriveId,
          fileId: first?.fileId ?? null,
        });
        archive.append(bytes, { name: entryName });
        exported.push(row);
      } catch (error: any) {
        console.error(`Bulk download: could not open document ${row.id}:`, error);
        errors.push(`${row.title}: ${error?.message || 'could not be decrypted'}`);
      }
    }

    for (const id of ids) {
      if (!rows.some((r) => r.id === id)) errors.push(`${id}: not found`);
    }

    if (errors.length > 0) {
      archive.append(
        `These items were not included:\n\n${errors.map((e) => `  - ${e}`).join('\n')}\n`,
        { name: '_errors.txt' },
      );
    }

    // Drives the stream; deliberately not awaited — the response streams as
    // entries are written rather than buffering the whole archive first.
    archive.finalize().catch((err) => console.error('Bulk download finalize failed:', err));

    // One row per document, matching what bulk-delete writes: an export that
    // says only "2 documents" cannot answer which two left the vault, or whose
    // they were — which is the whole question an export log has to settle.
    for (const row of exported) {
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.documents.bulk_export,
        details: auditSentence('bulk_export', {
          kind: 'document',
          name: row.title,
          category: categoryPhrase(row.categoryModuleKey, row.categoryDocumentKey),
          member: row.holderName,
          note: exported.length > 1
            ? `one of ${exported.length} downloaded together as a ZIP archive`
            : 'as a ZIP archive',
        }),
        req,
        entityType: 'documents',
        entityId: row.id,
      });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(Readable.toWeb(archive) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="documents-${stamp}.zip"`,
        // Authed content — no shared cache may hold it.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return serverError(error, 'processing download documents');
  }
}
