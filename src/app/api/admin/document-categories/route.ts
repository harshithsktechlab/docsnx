/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/admin/document-categories — the taxonomy itself                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Its sibling /api/admin/document-fields configures what a sub-category
 * COLLECTS. This one decides which sub-categories exist at all — the thing that
 * previously required editing src/lib/documentCategories.ts, writing a migration
 * and deploying.
 *
 * ── WHAT AN OPERATOR IS AGREEING TO ────────────────────────────────────────
 * `document_categories` has no tenant column — it was deliberately dropped in
 * drizzle/0006 — so this taxonomy is GLOBAL. A category created here appears for
 * every tenant on the platform, in their sidebar, their upload picker and their
 * AI classification. The screen says so before the click; there is no per-tenant
 * variant of this and adding one would mean a tenant column and a rewrite of
 * every query that reads the table.
 *
 * ── THE TWO HALVES OF THE SOURCE OF TRUTH ──────────────────────────────────
 * documentCategories.ts stays the SEED — what this build ships, what the seed
 * scripts write, what the tests assert. This route writes ROWS. The two coexist
 * because both seed scripts are upsert-only and never delete, so a re-seed
 * refreshes the shipped 83 and leaves an operator's rows untouched.
 *
 * A row created here is `is_system = false`, which is the only thing that
 * distinguishes it — and the only thing the screen needs in order to say where a
 * category came from.
 *
 * ── WHAT THIS ROUTE WILL NOT DO ────────────────────────────────────────────
 *  · CHANGE A KEY. Not in any schema here, at any verb. `(moduleKey,
 *    documentKey)` names the Drive folder every record of that category is
 *    stored in and is bound into that ciphertext's AAD; renaming either half
 *    orphans the data AND makes it undecryptable. Display names are free to
 *    change — that is what they are for.
 *  · DELETE A ROW. `documents.category_id` is ON DELETE RESTRICT, and the only
 *    sanctioned deletion in this table's history (drizzle/0036) first had to
 *    prove three separate reference classes empty. Retiring is `is_active =
 *    false`, which stops the category being offered, navigated to, classified
 *    into or written to, while every record already filed under it stays
 *    readable.
 *  · CREATE A MODULE. Not yet — see the note on POST.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  documentCategories,
  documentCategoryFieldOverrides,
  documentCategoryFields,
  documents,
} from '@/db/schema';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '@/lib/audit';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { categoryLabel } from '@/lib/documentCategories';
import { invalidateTaxonomy } from '@/lib/taxonomyRegistry';
import { baselineSpecFor } from '@/lib/documentCategoryFields';
import { labelError, taxonomyKeyFrom } from '@/lib/records/taxonomyKey';
import { homeScopeForModule } from '@/lib/records/registry';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** Display names. Long enough for the longest shipped one, which is 84 chars. */
const NameSchema = z.string().trim().min(1).max(200);

const CreateSchema = z.object({
  /** The module to add a sub-category to. Must already exist and be active. */
  moduleKey: z.string().min(1).max(60),
  documentName: NameSchema,
});

/**
 * Everything a row may become. Note what is absent: `moduleKey`,
 * `documentKey`, `isSystem`. The first two are immutable; the third is set once,
 * by the code path that created the row, and an operator flipping it would turn
 * a shipped category into a deletable one or vice versa.
 */
const PatchSchema = z.object({
  moduleKey: z.string().min(1).max(60),
  documentKey: z.string().min(1).max(60),
  documentName: NameSchema.optional(),
  /** Renames the module EVERYWHERE — see the note in PATCH. */
  moduleName: NameSchema.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
}).refine(
  (v) => v.documentName !== undefined || v.moduleName !== undefined
    || v.isActive !== undefined || v.sortOrder !== undefined,
  { message: 'Nothing to change.' },
);

/**
 * How many live records are filed under each category, keyed `module/document`.
 *
 * One grouped query rather than 83, and deliberately NOT tenant-scoped: this is
 * a platform-wide count, and the operator is judging how many records a change
 * will affect across every tenant. A tombstoned or half-uploaded row is not
 * blast radius, so `visibleDocument()` — the canonical predicate — applies.
 */
async function recordCounts(): Promise<Map<string, number>> {
  /**
   * Grouped on the DENORMALISED pair rather than joined to
   * `document_categories`.
   *
   * It is the same answer — `documents` carries the pair precisely so the
   * category can be known without a join — and it is the answer
   * `documents_category_visible_idx` can give as an index-only scan. With the
   * join this was a heap scan of every row on the platform, which is what makes
   * it the screen that dies first at volume (drizzle/0051).
   *
   * Rows written before the vault carry a NULL pair; they are excluded by the
   * grouping keys being NULL and were never counted under a category anyway.
   */
  const rows = await db
    .select({
      moduleKey: documents.categoryModuleKey,
      documentKey: documents.categoryDocumentKey,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(documents)
    .where(visibleDocument())
    .groupBy(documents.categoryModuleKey, documents.categoryDocumentKey);
  return new Map(
    rows
      .filter((r) => r.moduleKey && r.documentKey)
      .map((r) => [categoryLabel({
        moduleKey: r.moduleKey as string,
        documentKey: r.documentKey as string,
      }), r.count]),
  );
}

/**
 * GET — every row, active and retired, with what each one costs to change.
 *
 * Retired rows are INCLUDED here where they are excluded everywhere else: this
 * is the screen that retired them and the only one that can restore them. A
 * retired category invisible on its own admin page would be unrecoverable.
 */
export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const rows = await db
      .select({
        id: documentCategories.id,
        moduleNo: documentCategories.moduleNo,
        moduleKey: documentCategories.moduleKey,
        moduleName: documentCategories.moduleName,
        documentKey: documentCategories.documentKey,
        documentName: documentCategories.documentName,
        sortOrder: documentCategories.sortOrder,
        isSystem: documentCategories.isSystem,
        isActive: documentCategories.isActive,
        // So the screen can mark which categories have been configured on the
        // Fields tab without opening all 83.
        overrides: sql<number>`(
          SELECT count(*) FROM ${documentCategoryFieldOverrides} o
           WHERE o.category_id = ${documentCategories.id}
        )`.mapWith(Number),
      })
      .from(documentCategories)
      .orderBy(documentCategories.moduleNo, documentCategories.sortOrder);

    const counts = await recordCounts();

    return NextResponse.json({
      success: true,
      categories: rows.map((r) => ({ ...r, recordCount: counts.get(categoryLabel(r)) ?? 0 })),
    });
  } catch (error) {
    return serverError(error, 'loading document categories');
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST — a new sub-category under an existing module                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY ONLY A SUB-CATEGORY, AND NOT A NEW MODULE ──────────────────────────
 * A sub-category inherits everything from the module above it: its members'
 * existing module-level permission row (`document_key IS NULL`) already grants
 * it, `homeScopeForModule` gives it a page, its Drive folder sits under a module
 * folder that exists, and it has a colour and an icon.
 *
 * A MODULE has none of that. It would need a permission row backfilled for every
 * member of every tenant (or it is denied to everyone but tenant admins, and
 * looks broken), an entry in the closed `VAULT_MODULES` list that
 * `buildJsonFileName` throws on, a Drive folder name, and a colour. Each is
 * doable and none is derivable from a label. Refused explicitly here rather than
 * accepted and half-working.
 *
 * ── THE SERVER OWNS THE KEY ────────────────────────────────────────────────
 * `documentKey` is absent from the schema on purpose. See taxonomyKey.ts: a
 * caller that could choose it could choose `pan_card` and take over the folder
 * every tenant's identity ciphertext already lives in.
 */
export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const parsed = CreateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { moduleKey, documentName } = parsed.data;

    const message = labelError(documentName);
    if (message) return NextResponse.json({ error: message }, { status: 400 });

    /**
     * Every row of the module, RETIRED ONES INCLUDED.
     *
     * Two questions at once, and both need the inactive rows: does this module
     * exist (a module IS its rows — there is no module table), and which keys
     * are spoken for. A retired row's key must never be reissued: its records
     * still point at it, and a new category under the same key would file new
     * records into the old one's Drive folder.
     */
    const siblings = await db
      .select({
        documentKey: documentCategories.documentKey,
        moduleNo: documentCategories.moduleNo,
        moduleName: documentCategories.moduleName,
        sortOrder: documentCategories.sortOrder,
        isActive: documentCategories.isActive,
      })
      .from(documentCategories)
      .where(eq(documentCategories.moduleKey, moduleKey));

    if (siblings.length === 0) {
      return NextResponse.json({ error: 'Unknown module' }, { status: 404 });
    }
    if (!siblings.some((s) => s.isActive)) {
      return NextResponse.json(
        { error: 'That module is retired. Restore one of its document types first.' },
        { status: 400 },
      );
    }
    // A module with no page cannot list, create or show the records filed under
    // it. Unreachable for the 15 shipped modules; a guard against a module row
    // that predates or outlives the scope table.
    if (!homeScopeForModule(moduleKey)) {
      return NextResponse.json(
        { error: `No records page owns "${moduleKey}", so a document type added to `
          + 'it would have nowhere to be listed.' },
        { status: 400 },
      );
    }

    const documentKey = taxonomyKeyFrom(documentName, siblings.map((s) => s.documentKey));
    if (!documentKey) {
      return NextResponse.json(
        { error: 'Give this document type a name using letters or numbers.' },
        { status: 400 },
      );
    }
    const categoryKey = { moduleKey, documentKey };

    // The module's own number and label, copied from its existing rows rather
    // than asked for: they are properties of the MODULE, and a row that
    // disagreed with its siblings would sort itself out of its own module.
    const { moduleNo, moduleName } = siblings[0];
    const sortOrder = siblings.reduce((max, s) => Math.max(max, s.sortOrder), 0) + 10;

    /**
     * The row, then its field spec, in one transaction.
     *
     * A category with no `document_category_fields` row falls back to
     * `fieldsFor()`, which answers `[]` for a key the dictionary never declared
     * — no `document_title`, so its add form renders empty and every save is
     * refused. Half of this write is a category nobody can file anything under,
     * so it is not allowed to be half-written.
     */
    const spec = baselineSpecFor(categoryKey);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documentCategories)
        .values({
          moduleNo,
          moduleKey,
          documentKey,
          moduleName,
          documentName,
          sortOrder,
          isSystem: false,
          isActive: true,
        })
        .returning({ id: documentCategories.id });

      await tx.insert(documentCategoryFields).values({
        categoryId: row.id,
        fields: spec.fields as unknown as object,
        encryptedFields: spec.encryptedFieldsCsv,
        mandatoryFields: spec.mandatoryFieldsCsv,
        allFields: spec.allFieldsCsv,
        ocrFields: spec.ocrFieldsCsv,
      });
    });

    invalidateTaxonomy();

    await writeAudit({
      action: ACTIONS.document_category.update,
      // The MODULE is the category here, not the pair: the thing created IS the
      // sub-category, so naming it as both the subject and its own container
      // would read "created document type X in X".
      details: auditSentence('create', {
        kind: 'document type',
        name: documentName,
        category: moduleName,
        note: 'global — every tenant now has it',
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'document_categories',
      entityId: categoryLabel(categoryKey),
      req,
    });

    return NextResponse.json({ success: true, moduleKey, documentKey });
  } catch (error) {
    return serverError(error, 'saving document categories');
  }
}

/**
 * PATCH — rename, reorder, retire or restore one row.
 *
 * Applies to SHIPPED rows too, and that is intended: display names are
 * explicitly editable (documentCategories.ts calls them display-only), and a
 * platform operator renaming "Others" to "Miscellaneous" is a legitimate thing
 * to want. The key is what is protected, not the label.
 */
export async function PATCH(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { moduleKey, documentKey, documentName, moduleName, isActive, sortOrder } = parsed.data;
    const categoryKey = { moduleKey, documentKey };

    for (const name of [documentName, moduleName]) {
      if (name === undefined) continue;
      const message = labelError(name);
      if (message) return NextResponse.json({ error: message }, { status: 400 });
    }

    const [row] = await db
      .select({
        id: documentCategories.id,
        documentName: documentCategories.documentName,
        isActive: documentCategories.isActive,
      })
      .from(documentCategories)
      .where(and(
        eq(documentCategories.moduleKey, moduleKey),
        eq(documentCategories.documentKey, documentKey),
      ))
      .limit(1);
    if (!row) return NextResponse.json({ error: 'Unknown category' }, { status: 404 });

    /**
     * Retiring the LAST active row of a module retires the module itself — it
     * would vanish from the sidebar, and its remaining records would be reachable
     * only through the documents list. Refused, because it is almost never what
     * the operator meant and there is no "restore module" to undo it with; they
     * can still retire the rows one at a time down to the last.
     */
    if (isActive === false) {
      const [{ active = 0 } = { active: 0 }] = await db
        .select({ active: sql<number>`count(*)`.mapWith(Number) })
        .from(documentCategories)
        .where(and(
          eq(documentCategories.moduleKey, moduleKey),
          eq(documentCategories.isActive, true),
        ));
      if (active <= 1 && row.isActive) {
        return NextResponse.json({
          error: 'This is the last active document type in its module. Retiring it '
            + 'would remove the whole module from every tenant\'s navigation.',
        }, { status: 400 });
      }
    }

    const changes: string[] = [];
    if (documentName !== undefined) changes.push(`name → "${documentName}"`);
    if (moduleName !== undefined) changes.push(`module name → "${moduleName}"`);
    if (sortOrder !== undefined) changes.push(`order → ${sortOrder}`);
    if (isActive !== undefined) changes.push(isActive ? 'restored' : 'retired');

    await db.transaction(async (tx) => {
      await tx
        .update(documentCategories)
        .set({
          ...(documentName !== undefined ? { documentName } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(documentCategories.id, row.id));

      /**
       * A module name lives denormalised on every one of its rows, so renaming
       * a module is an update of all of them. Doing only the addressed row would
       * leave a module whose name depends on which sub-category you happened to
       * look at, and the sidebar groups by key while LABELLING from the first
       * row it meets.
       */
      if (moduleName !== undefined) {
        await tx
          .update(documentCategories)
          .set({ moduleName, updatedAt: new Date() })
          .where(eq(documentCategories.moduleKey, moduleKey));
      }
    });

    invalidateTaxonomy();

    await writeAudit({
      action: ACTIONS.document_category.update,
      // `categoryPhrase` reads the name off the row rather than the key, so a
      // rename is audited under the name it HAD — which is the one a reader
      // looking back at this line would recognise.
      details: auditSentence('update', {
        kind: 'document type',
        name: categoryPhrase(moduleKey, documentKey) ?? row.documentName,
        note: changes.join(', '),
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'document_categories',
      entityId: categoryLabel(categoryKey),
      req,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'updating document categories');
  }
}
