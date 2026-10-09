import { and, desc, eq, inArray } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { hasPermission } from '@/lib/auth';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import {
  documentManagerContext, inCategories, inCompany, revealRecord,
} from '@/lib/records/handler';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { servableFilePath } from '@/lib/records/fileUrl';
import {
  PROFILE_ID_DOCUMENTS, PROFILE_ID_MODULE_KEY, applyIdNumberToProfile,
  type ProfileIdKind,
} from '@/lib/profileUpdater';

export interface ProfileIdDocument {
  /** The category an upload from the profile files into. */
  categoryId: string | null;
  /** May the caller add a document of this kind? */
  canUpload: boolean;
  /** The newest document of this kind held by the member, if any. */
  document: {
    id: string;
    title: string;
    fileName: string | null;
    fileUrl: string | null;
    createdAt: Date | null;
  } | null;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  THE PROFILE'S ID DOCUMENTS ARE THE DOCUMENT MANAGER'S                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * The Legal / ID tab stores no files of its own. The PAN / Aadhaar / passport
 * it shows are the member's `identity/*` records in `documents` — so a card
 * filed in the Document Manager appears here, and one uploaded here (which
 * posts to `/api/documents`) appears there, with nothing to keep in step.
 *
 * Scoped like any Document Manager read: tenant predicate inside `withTenant`,
 * personal workspace only, live rows only, and only categories the caller may
 * view.
 *
 * When the profile has no number for a kind but a document exists, the number
 * is read back off that document and saved into the profile. That is what
 * brings in cards filed before the two were linked; it touches Drive only for
 * a kind whose number is missing.
 */
export async function loadProfileIdDocuments(
  user: any,
  holderId: string,
  legalDetails: Record<string, any>,
): Promise<{ idDocuments: Record<ProfileIdKind, ProfileIdDocument>; backfilled: boolean }> {
  const kinds = Object.keys(PROFILE_ID_DOCUMENTS) as ProfileIdKind[];
  const ctx = await documentManagerContext(user, 'view', null);

  const rows = await withTenant(user.tenantId, (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      fileName: documents.fileName,
      filePath: documents.filePath,
      fileDriveId: documents.fileDriveId,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      createdAt: documents.createdAt,
    })
      .from(documents)
      .where(and(
        eq(documents.tenantId, user.tenantId),
        eq(documents.holderId, holderId),
        eq(documents.categoryModuleKey, PROFILE_ID_MODULE_KEY),
        inArray(documents.categoryDocumentKey, kinds.map((k) => PROFILE_ID_DOCUMENTS[k].documentKey)),
        inCompany(null),
        inCategories(ctx.keys),
        visibleDocument(),
      ))
      .orderBy(desc(documents.createdAt)),
  );

  const idDocuments = {} as Record<ProfileIdKind, ProfileIdDocument>;
  let backfilled = false;

  for (const kind of kinds) {
    const def = PROFILE_ID_DOCUMENTS[kind];
    const row = rows.find((r) => r.categoryDocumentKey === def.documentKey) ?? null;

    const category = await withTenant(user.tenantId, (tx) =>
      resolveCategory(tx, null, { moduleKey: PROFILE_ID_MODULE_KEY, documentKey: def.documentKey }),
    );
    const canUpload = Boolean(category) &&
      await hasPermission(user, PROFILE_ID_MODULE_KEY, 'add', def.documentKey);

    idDocuments[kind] = {
      categoryId: category?.id ?? null,
      canUpload,
      document: row ? {
        id: row.id,
        title: row.title,
        fileName: row.fileName,
        fileUrl: servableFilePath(row),
        createdAt: row.createdAt,
      } : null,
    };

    if (row && !legalDetails?.[def.legalKey]) {
      try {
        const revealed = await revealRecord(ctx, row.id);
        const number = revealed?.sealed?.[def.fieldKey];
        if (number && await applyIdNumberToProfile(holderId, kind, number)) backfilled = true;
      } catch (err) {
        // The card is still listed; only the number stays blank until the
        // store can be read.
        console.error(`[profile] could not read the ${kind} number back from its document:`, err);
      }
    }
  }

  return { idDocuments, backfilled };
}
