/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE MODULE — how much is in each of its sub-categories                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `GET /api/modules/:moduleKey/counts` — what the module page puts on each
 * sub-category tile, so a reader can see where their records are and what needs
 * attention before clicking into anything.
 *
 * ── WHY NOT THE SUMMARY ENDPOINT, ONCE PER TILE ────────────────────────────
 * Business has sixteen sub-categories; that would be sixteen requests, each
 * opening a category's store on Drive. This answers the whole module in ONE
 * Postgres query and touches Drive not at all.
 *
 * ── WHERE THE DATES COME FROM ──────────────────────────────────────────────
 * The records' `reminders`, in the tenant's encrypted stores on Drive — read
 * through `remindersForCategory`, the same walk `/follow-up` and the Summary tab
 * use, so all three agree by construction.
 *
 * This used to read a `documents.metadata` projection instead and touch Drive
 * not at all: one Postgres query for the whole module. That column is gone (all
 * user data renders from Drive), so the cost is now one store read per PERMITTED
 * sub-category — sixteen for Business on a cold cache, and near-free afterwards,
 * since `storeCache` holds each store for 30 minutes and revalidates against the
 * pointer revision rather than a TTL guess.
 *
 * What it gains for that: `reminders` carry the `resolved` flag (a paid bill),
 * which the projection did not, so a tile no longer counts a settled bill as due.
 *
 * The counts stay per RECORD, not per reminder — a vehicle tracking insurance,
 * PUC and fitness is one overdue vehicle, not three — so each record contributes
 * only its earliest unresolved deadline, exactly as before.
 *
 * ── PERMISSIONS ────────────────────────────────────────────────────────────
 * One `hasPermission` per sub-category, exactly like `/api/document-categories`.
 * A denied sub-category is absent from the response — not zero, absent — so the
 * page renders no tile for it rather than a tile that 403s.
 *
 * Asked of the CANONICAL category, which for all but a mirror is the
 * sub-category itself. A mirrored tile (Vehicle's "Vehicle insurance", whose
 * records live in Insurance) is governed by the Insurance permission, so it is
 * not a way around one — see src/lib/categoryMirrors.ts.
 *
 * ── A MIRRORED TILE COUNTS LIKE ANY OTHER ──────────────────────────────────
 * A mirror tile reports its canonical category's numbers, so opening Vehicle
 * shows how many motor policies are on file, and the module page adds them into
 * its header total exactly as it does every other tile. Two modules therefore
 * report the same record.
 *
 * That is one fact stated from two places, not two records: it exists once, as
 * one row with one Drive object. The tile carries `mirrored` and `mirrorOf` so
 * the page can SAY where its records live, which is what keeps the number
 * honest — and the consequence to keep in mind is that module totals no longer
 * sum to the document total, so nothing sums them.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPermission, hasPersonalAccess } from '@/lib/auth';
import { type CategoryKey, categoryLabel } from '@/lib/documentCategories';
import { canonicalCategory, isMirrorAlias } from '@/lib/categoryMirrors';
import { companyIdFromRequest, inCategories, inCompany } from '@/lib/records/handler';
import { BUSINESS_MODULE_PREFIX } from '@/lib/documentCategories';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { daysUntil, remindersForCategory } from '@/lib/records/followUps';
import { subCategoriesLive } from '@/lib/taxonomyRegistry';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** Inside this many days counts as "coming up" on a tile. */
const DUE_SOON_DAYS = 30;

type Params = { params: Promise<{ moduleKey: string }> };

export interface SubCategoryCount {
  documentKey: string;
  total: number;
  withFile: number;
  /** Details entered, no document attached. */
  dataOnly: number;
  overdue: number;
  dueSoon: number;
  /** ISO date of the soonest unpassed deadline, or null. */
  nextDueAt: string | null;
  lastAddedAt: string | null;
  /**
   * This tile's records are STORED in another module, and displayed by both.
   *
   * The numbers above are this tile's to show and this module's to total — the
   * point of a mirror is that opening Vehicle tells you how many motor policies
   * you hold. The flag is not an instruction to discount them; it is what lets
   * the page say WHERE they live, so a reader knows the Insurance module is
   * showing the same record rather than a second copy.
   *
   * See src/lib/categoryMirrors.ts.
   */
  mirrored: boolean;
  /** Which category they are stored in, for the tile's "Shared from" badge. */
  mirrorOf: CategoryKey | null;
}

/** One permitted tile: what to show it as, and which category to count. */
interface Tile {
  /** The sub-category as this module addresses it — the tile's own key. */
  documentKey: string;
  /** Where its records are stored. Identical to the tile for all but a mirror. */
  canonical: CategoryKey;
  mirrored: boolean;
}

/**
 * Every deadline in this module, reduced to the soonest UNRESOLVED one per
 * record.
 *
 * `remindersForCategory` filters by a day threshold because its usual caller is
 * a "what needs attention" list; a tile has to count an expiry three years out
 * as well, so the threshold is opened all the way and the narrowing happens
 * here. POSITIVE_INFINITY specifically, not a very large number: that is what
 * tells `remindersForCategory` to skip the per-field alert windows too, which
 * would otherwise narrow this back down to what /follow-up shows. One store read per sub-category, served from `storeCache`.
 *
 * A store that cannot be read yields no deadlines for its sub-category rather
 * than failing the module — the tile then shows its totals with no due counts,
 * which is the same degradation the follow-up page accepts.
 */
async function earliestDeadlineByRecord(
  ctx: { tenant: any; tenantId: string; userId: string; companyId: string | null },
  rowsByCategory: Map<string, { key: CategoryKey; rows: Array<{ id: string; title: string | null }> }>,
): Promise<Map<string, number>> {
  const earliest = new Map<string, number>();

  for (const { key, rows } of rowsByCategory.values()) {
    // The CANONICAL pair: that is the store on Drive the reminders are in. A
    // mirror address has no store of its own and never did.
    const items = await remindersForCategory(
      ctx,
      key,
      rows,
      { thresholdDays: Number.POSITIVE_INFINITY },
    );
    for (const item of items) {
      const time = new Date(item.dueDate).getTime();
      if (Number.isNaN(time)) continue;
      const prev = earliest.get(item.recordId);
      if (prev === undefined || time < prev) earliest.set(item.recordId, time);
    }
  }

  return earliest;
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { moduleKey } = await params;

    // The segment selects which rows the request can reach, so an unknown
    // module is a 404 before anything else runs.
    const subCategories = await subCategoriesLive(moduleKey);
    if (subCategories.length === 0) {
      return NextResponse.json({ error: 'Unknown module' }, { status: 404 });
    }

    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    /**
     * ── THE COMPANY GATE, SPELLED OUT ────────────────────────────────────────
     *
     * This route does its own authentication rather than going through
     * `withRecordScope`, because it answers per TILE rather than per scope. That
     * means it must also do its own company gating — and a route that reads
     * `documents` without one would report every company's counts to every
     * company, and the personal counts to all of them.
     *
     * Same four rules as the shared gate: shape-check, require agreement
     * between the module's taxonomy and the company, then prove access to
     * whichever workspace was named — a company, or the household.
     */
    const companyId = companyIdFromRequest(req);
    if (companyId === undefined) {
      return NextResponse.json({ error: 'Invalid company' }, { status: 400 });
    }
    const wantsCompany = moduleKey.startsWith(BUSINESS_MODULE_PREFIX);
    if (wantsCompany !== Boolean(companyId)) {
      return NextResponse.json(
        { error: wantsCompany
          ? 'This module belongs to a company. Choose one first.'
          : 'This module is personal and takes no company.' },
        { status: 400 },
      );
    }
    if (companyId && !await hasCompanyAccess(user, companyId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // The household, proven like any other workspace. The per-tile permission
    // loop below already leaves a business member with no tiles here, so this
    // is defence in depth — and it keeps this gate spelled identically to
    // `resolveUtilityCompany`, which is the point of writing it out.
    if (!companyId && !hasPersonalAccess(user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Each tile is permission-checked on the category its records are IN, which
    // for a mirror is another module's. Granting Vehicle therefore does not open
    // the motor policies; the Insurance permission does. See categoryMirrors.ts.
    const tiles: Tile[] = [];
    for (const sub of subCategories) {
      const tile = { moduleKey, documentKey: sub.documentKey };
      const canonical = canonicalCategory(tile);
      if (await hasPermission(user, canonical.moduleKey, 'view', canonical.documentKey)) {
        tiles.push({
          documentKey: sub.documentKey,
          canonical,
          mirrored: isMirrorAlias(tile),
        });
      }
    }
    if (tiles.length === 0) {
      return NextResponse.json({ success: true, counts: {} });
    }

    /**
     * canonical label → the tile that displays it.
     *
     * Rows come back carrying the category they are STORED under, which for a
     * mirrored tile is not the tile's own key, so they cannot be attributed by
     * `documentKey` alone any more.
     */
    const tileByCanonical = new Map<string, Tile>(
      tiles.map((tile) => [categoryLabel(tile.canonical), tile]),
    );

    // `inCategories` rather than a module-scoped `inArray`: a mirrored tile's
    // rows are in a DIFFERENT module, so the module predicate would exclude
    // exactly the ones it exists to show. The helper groups the pairs by module
    // and emits one `IN` per module, which for an ordinary module is the same
    // single clause as before.
    const rows = await withTenant(user.tenantId, (tx) =>
      tx.select({
        id: documents.id,
        title: documents.title,
        moduleKey: documents.categoryModuleKey,
        documentKey: documents.categoryDocumentKey,
        filePath: documents.filePath,
        createdAt: documents.createdAt,
      })
        .from(documents)
        .where(and(
          eq(documents.tenantId, user.tenantId),
          inCompany(companyId),
          inCategories(tiles.map((tile) => tile.canonical)),
          visibleDocument(),
        )),
    );

    // Seeded with a zero row per permitted tile: a tile must be able to say
    // "nothing filed yet" rather than have no entry to read.
    const counts: Record<string, SubCategoryCount> = Object.fromEntries(
      tiles.map((tile) => [tile.documentKey, {
        documentKey: tile.documentKey,
        total: 0,
        withFile: 0,
        dataOnly: 0,
        overdue: 0,
        dueSoon: 0,
        nextDueAt: null,
        lastAddedAt: null,
        mirrored: tile.mirrored,
        mirrorOf: tile.mirrored ? tile.canonical : null,
      }]),
    );

    /** The tile a row belongs to, by the category it is stored under. */
    const tileFor = (row: { moduleKey: string | null; documentKey: string | null }) => (
      row.moduleKey && row.documentKey
        ? tileByCanonical.get(categoryLabel({ moduleKey: row.moduleKey, documentKey: row.documentKey }))
        : undefined
    );

    // Grouped before any store is opened, so each category is read once however
    // many records it holds. Keyed by the CANONICAL pair, which is the store.
    const rowsByCategory = new Map<
      string,
      { key: CategoryKey; rows: Array<{ id: string; title: string | null }> }
    >();
    for (const row of rows) {
      const tile = tileFor(row);
      if (!tile) continue;
      const label = categoryLabel(tile.canonical);
      const bucket = rowsByCategory.get(label);
      if (bucket) bucket.rows.push(row);
      else rowsByCategory.set(label, { key: tile.canonical, rows: [row] });
    }

    const deadlines = await earliestDeadlineByRecord(
      // The company this request was gated for, so the reminder read opens the
      // same vault the counts above were taken from.
      { tenant: user.tenant, tenantId: user.tenantId, userId: user.id, companyId },
      rowsByCategory,
    );

    for (const row of rows) {
      const tile = tileFor(row);
      const bucket = tile ? counts[tile.documentKey] : undefined;
      if (!bucket) continue;

      bucket.total += 1;
      if (row.filePath) bucket.withFile += 1;
      else bucket.dataOnly += 1;

      const added = new Date(row.createdAt).toISOString();
      if (!bucket.lastAddedAt || added > bucket.lastAddedAt) bucket.lastAddedAt = added;

      const deadline = deadlines.get(row.id);
      if (deadline === undefined) continue;

      const days = daysUntil(new Date(deadline));
      if (days < 0) {
        bucket.overdue += 1;
      } else {
        if (days <= DUE_SOON_DAYS) bucket.dueSoon += 1;
        const iso = new Date(deadline).toISOString();
        if (!bucket.nextDueAt || iso < bucket.nextDueAt) bucket.nextDueAt = iso;
      }
    }

    return NextResponse.json({ success: true, counts });
  } catch (error) {
    return serverError(error, 'loading counts');
  }
}
