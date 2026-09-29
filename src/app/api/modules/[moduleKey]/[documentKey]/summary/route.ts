/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE SUB-CATEGORY — the Summary tab                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `GET /api/modules/:moduleKey/:documentKey/summary` — what the user should
 * know about this sub-category before they scroll its file list.
 *
 * Three questions, in the order people actually ask them:
 *
 *   1. WHAT IS DUE?      renewals and expiries, overdue first. The only part
 *                        that is genuinely urgent.
 *   2. WHAT IS MISSING?  members with nothing on file, records with no
 *                        scan attached, records whose required fields are blank.
 *   3. HOW MUCH IS HERE? counts, pages, storage, recent activity.
 *
 * ── TWO SOURCES, ONE DEGRADES ──────────────────────────────────────────────
 * Counts come from Postgres — cheap, always available. Due dates come from the
 * reminders in the category's Drive store, which is one `readJsonStore` (the
 * same call the follow-up page makes per category, so this adds no new cost
 * model). If Drive is unreachable the dated blocks come back empty and the
 * counts still render: a summary that says "12 records, renewals unavailable"
 * is useful, and one that 500s is not.
 *
 * ── PERMISSIONS ────────────────────────────────────────────────────────────
 * `withCategory` narrows `ctx.keys` to the single pair the URL names, and every
 * query filters on `inCategories(ctx.keys)`. A member who cannot view this
 * sub-category gets a 403 from the gate, never a count of records they cannot
 * open.
 */
import { NextResponse } from 'next/server';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { inCategories, inCompany, memberNames, withCategory } from '@/lib/records/handler';
import { workspaceMembers } from '@/lib/records/workspaceMembers';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { remindersForCategory, daysUntil } from '@/lib/records/followUps';
import { recordScopeConfig, scopeForCategory } from '@/lib/records/registry';
import { categoryDescriptor } from '@/lib/taxonomyRegistry';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ moduleKey: string; documentKey: string }> };

/** A record untouched for this long is probably stale, not merely old. */
const STALE_AFTER_DAYS = 365;

/** How far ahead the "coming up" buckets look. */
const HORIZONS = [30, 60, 90] as const;

export async function GET(req: Request, { params }: Params) {
  const { moduleKey, documentKey } = await params;
  // Canonicalised: a mirror alias is a second ADDRESS for another category,
  // so the field spec, the display names, the reminders and the audit phrase
  // must all be the canonical one's. See src/lib/categoryMirrors.ts.
  const categoryKey = canonicalCategory({ moduleKey, documentKey });

  return withCategory(req, categoryKey, 'view', async (ctx) => {
    try {
      const { user } = ctx;
      const scope = scopeForCategory(categoryKey);
      const config = scope ? recordScopeConfig(scope) : null;

      // Everything Postgres can answer, in one pass over this category's rows.
      // Small by construction — one sub-category of one tenant — so the rows
      // are aggregated here rather than in five separate COUNT queries.
      const { rows, members, holderNames } = await withTenant(user.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: documents.id,
            title: documents.title,
            holderId: documents.holderId,
            isGlobal: documents.isGlobal,
            filePath: documents.filePath,
            fileSize: documents.fileSize,
            pageCount: documents.pageCount,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
          })
          .from(documents)
          .where(and(
            eq(documents.tenantId, user.tenantId),
            // The company this request was gated for. Without it a company's
            // summary would count the personal records too, and vice versa.
            inCompany(ctx.companyId),
            inCategories(ctx.keys),
            visibleDocument(),
          ))
          .orderBy(sql`${documents.createdAt} DESC`);

        // Who could be missing one — THIS workspace's members, not the
        // tenant's. A company's coverage card listed every household member as
        // missing its board minutes, and the household's listed every employee
        // as missing a PAN. Same predicate as the "Belongs to" picker and the
        // write-side check (see src/lib/records/workspaceMembers.ts). Not
        // gated: knowing who is in your own workspace is not a permission.
        const members = await workspaceMembers(user.tenantId, ctx.companyId, tx);

        // Holder NAMES for the renewal rows, resolved tenant-wide on purpose:
        // a label for a record that exists, not a claim about who belongs here.
        // An older row filed under someone outside the workspace still names
        // them rather than rendering blank.
        const holderNames = await memberNames(
          user.tenantId,
          rows.map((r) => r.holderId),
          tx,
        );

        return { rows, members, holderNames };
      });

      const now = Date.now();
      const staleBefore = now - STALE_AFTER_DAYS * 86_400_000;
      const monthAgo = now - 30 * 86_400_000;

      const withFile = rows.filter((r) => Boolean(r.filePath));
      const stale = rows.filter((r) => new Date(r.updatedAt).getTime() < staleBefore);

      // Members with nothing on file. Only meaningful where a record belongs to
      // a person: a household warranty is not "missing" for anybody, and
      // listing five names under an appliance AMC would be pure noise.
      const householdByDefault = config?.defaultIsGlobal ?? false;
      const holdersPresent = new Set(
        rows.filter((r) => r.holderId).map((r) => r.holderId as string),
      );
      const coversAllMembers = rows.some((r) => r.isGlobal);
      const missingMembers = householdByDefault
        ? []
        : members
          .filter((m) => !holdersPresent.has(m.id))
          .map(({ id, name }) => ({ id, name }));

      // The dated half. Isolated so a Drive failure costs only this block.
      let reminders: Awaited<ReturnType<typeof remindersForCategory>> = [];
      let remindersAvailable = true;
      try {
        reminders = await remindersForCategory(
          // The gated company, so this opens the store the records are
          // actually in. Omitting it reads the personal vault and reports
          // "nothing is due" for every company record on the page.
          { tenant: user.tenant, tenantId: user.tenantId, userId: user.id, companyId: ctx.companyId },
          categoryKey,
          rows,
          // Everything dated, not just the next fortnight: this page shows the
          // 30/60/90 horizon, while /follow-up shows what is urgent now.
          // `strict` so an unreadable store says so rather than reading as
          // "nothing is due" — the one wrong answer this block can give.
          { thresholdDays: Number.POSITIVE_INFINITY, strict: true },
        );
      } catch (error) {
        // Any failure to READ the store is reported as "unavailable"; the counts
        // below are unaffected and still render.
        console.error(`[summary] reminders for ${moduleKey}/${documentKey}:`, error);
        remindersAvailable = false;
      }

      const upcoming = [...reminders].sort((a, b) => a.daysLeft - b.daysLeft);
      const overdue = upcoming.filter((r) => r.daysLeft < 0);
      const dueWithin = Object.fromEntries(
        HORIZONS.map((days) => [
          days,
          upcoming.filter((r) => r.daysLeft >= 0 && r.daysLeft <= days).length,
        ]),
      ) as Record<(typeof HORIZONS)[number], number>;

      // recordId → the holder's display name, for the renewal rows.
      const holderById = new Map(
        rows
          .filter((r) => r.holderId)
          .map((r) => [r.id, holderNames.get(r.holderId as string) ?? null] as const),
      );

      return NextResponse.json({
        success: true,
        // Canonical identity plus its mirror addresses — see categoryDescriptor.
        category: await categoryDescriptor(categoryKey),
        counts: {
          total: rows.length,
          withFile: withFile.length,
          // Data entered but no scan uploaded — the commonest kind of "missing".
          dataOnly: rows.length - withFile.length,
          pages: rows.reduce((n, r) => n + (r.pageCount ?? 0), 0),
          storageBytes: rows.reduce((n, r) => n + (r.fileSize ?? 0), 0),
          addedLast30Days: rows.filter((r) => new Date(r.createdAt).getTime() >= monthAgo).length,
          stale: stale.length,
        },
        coverage: householdByDefault ? null : {
          totalMembers: members.length,
          coveredMembers: members.length - missingMembers.length,
          /** Whole-household records count for everyone, so say so. */
          coversAllMembers,
          missing: missingMembers,
        },
        renewals: {
          available: remindersAvailable,
          overdue: overdue.length,
          dueWithin,
          /**
           * Soonest first, overdue at the top — as PARTS, not as a sentence.
           *
           * The page leads with `recordTitle` and labels the date with
           * `fieldLabel`, so a reader can tell which document needs renewing
           * and why at a glance, and click straight through to it. Rendering
           * `message` here instead buried the document's name mid-sentence.
           */
          next: upcoming.slice(0, 6).map((r) => ({
            id: r.id,
            recordId: r.recordId,
            recordTitle: r.recordTitle,
            fieldLabel: r.fieldLabel,
            holderName: holderById.get(r.recordId) ?? null,
            dueDate: r.dueDate,
            daysLeft: r.daysLeft,
            severity: r.severity,
          })),
        },
        attention: {
          /** Records that exist as data with no document behind them. */
          noFile: rows
            .filter((r) => !r.filePath)
            .slice(0, 5)
            .map((r) => ({ id: r.id, title: r.title })),
          stale: stale.slice(0, 5).map((r) => ({
            id: r.id,
            title: r.title,
            daysSinceUpdate: Math.abs(daysUntil(r.updatedAt)),
          })),
        },
        recent: rows.slice(0, 5).map((r) => ({
          id: r.id,
          title: r.title,
          createdAt: r.createdAt,
          hasFile: Boolean(r.filePath),
        })),
      });
    } catch (error) {
      const vault = vaultErrorResponse(error);
      if (vault) return vault;
      return serverError(error, 'loading summary');
    }
  });
}
