/**
 * The document category master list — the 82-row taxonomy plus the catch-all,
 * which is what every category dropdown in the app is built from.
 *
 * Read-only. There is deliberately no POST: `document_categories` has no
 * tenant column (drizzle/0006_document_categories_drop_tenant.sql), so a
 * category created by one tenant would be a category for all of them. Adding a
 * category means appending to DOCUMENT_CATEGORY_MODULES in
 * src/lib/documentCategories.ts and shipping a migration.
 *
 * ── FILTERED, NOT GATED ────────────────────────────────────────────────────
 * There is no single permission key that means "the taxonomy" any more — since
 * 0023 the modules ARE the taxonomy, and since 0024 a member can hold some
 * sub-categories of a module and not others. So this returns the rows the CALLER
 * may view, one `hasPermission` per row, rather than allowing or denying the
 * whole list.
 *
 * That is what keeps a denied sub-category out of the picker: a member who
 * cannot view `bank_locker_agreement` never sees it offered, and the server
 * refuses it again on write (`ForbiddenCategoryError` in records/handler.ts).
 * The rows themselves are global reference data and reveal nothing tenant-owned.
 *
 * ── ?action= — FILTERED FOR WHAT, EXACTLY ──────────────────────────────────
 * `view` is the right question for a nav or a filter, and the wrong one for a
 * PICKER: an upload form built from the view list offers categories the member
 * cannot write to, and the upload then 403s on a choice the form itself made
 * available. So the caller says which action it is about to take, and gets the
 * categories that action is permitted on.
 *
 * Restricted to the three actions a picker can be for. `delete` and `share` act
 * on a record that already exists and are asked per row, not per category list.
 *
 * ── MIRRORS: LISTED FOR `view`, NEVER OFFERED FOR `add`/`edit` ─────────────
 * A mirrored category (src/lib/categoryMirrors.ts) is a second ADDRESS for
 * another module's category, not a second place to file. So:
 *
 *   view        it stays in. This is the list the sidebar and the module page
 *               are built from, and the whole point of a mirror is that Vehicle
 *               shows a "Vehicle insurance" row.
 *   add / edit  it is dropped. Its canonical is already in the list, so a
 *               picker offers the category exactly once — which is what stops a
 *               user choosing between two entries that mean the same thing.
 *
 * Either way the permission asked is the CANONICAL one: the records belong to
 * the module they are stored in, and a mirror must not be a way around that
 * module's permission.
 *
 * `mirrorOf` rides along on the row so a client can tell the two apart — the
 * documents page drops mirrored rows from its filter chips, since a filter
 * matches on `categoryId` and a mirror's id is on no document.
 */
import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documentCategories } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { canonicalCategory, isMirrorAlias } from '@/lib/categoryMirrors';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** What a caller may ask this list to be filtered for. See the header. */
const PICKER_ACTIONS = ['view', 'add', 'edit'] as const;
type PickerAction = (typeof PICKER_ACTIONS)[number];

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // A platform role has no tenant taxonomy to pick from.
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Rejected rather than defaulted: a typo'd action silently falling back to
    // `view` would hand a picker the permissive list, which is the exact bug
    // this parameter exists to fix.
    const requested = new URL(req.url).searchParams.get('action');
    if (requested && !PICKER_ACTIONS.includes(requested as PickerAction)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    const action: PickerAction = (requested as PickerAction) || 'view';

    const rows = await withTenant(user.tenantId, (tx) =>
      tx
        .select({
          id: documentCategories.id,
          moduleNo: documentCategories.moduleNo,
          moduleKey: documentCategories.moduleKey,
          documentKey: documentCategories.documentKey,
          moduleName: documentCategories.moduleName,
          documentName: documentCategories.documentName,
          isSystem: documentCategories.isSystem,
        })
        .from(documentCategories)
        .where(eq(documentCategories.isActive, true))
        .orderBy(
          asc(documentCategories.moduleNo),
          asc(documentCategories.sortOrder),
          asc(documentCategories.documentName),
        ),
    );

    const categories = [];
    for (const row of rows) {
      const mirrored = isMirrorAlias(row);
      // A picker must offer one entry per category, and the canonical is
      // already in this list.
      if (mirrored && action !== 'view') continue;
      const canonical = canonicalCategory(row);
      if (await hasPermission(user, canonical.moduleKey, action, canonical.documentKey)) {
        categories.push({ ...row, mirrorOf: mirrored ? canonical : null });
      }
    }

    return NextResponse.json({ success: true, categories });
  } catch (error) {
    return serverError(error, 'listing document categories');
  }
}
