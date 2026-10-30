/**
 * Search log — what was searched for and which document it led to.
 *
 * Called by the search box when a search ENDS: a result is opened, or the box is
 * closed on a query that found nothing. Not on every keystroke (the box debounces
 * its fetches; logging each would fill the table with prefixes — "ba", "ban",
 * "bank").
 *
 * What is stored is decided by `redactQuery`: descriptive words only. The
 * keyword -> document counts in `search_keywords` are the future tag source; a
 * search that found nothing is kept as a keyword row with no document.
 *
 * The document is looked up here, tenant-scoped, and the caller must still be
 * allowed to view it — a keyword must not be a way to attach a record the member
 * cannot see to anything. The tenant always comes from the session, never the body.
 */
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents, searchKeywords } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPermission, hasPersonalAccess } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { requireOnboarded } from '@/lib/onboardingGate';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { searchTrackRateLimiter } from '@/lib/rateLimit';
import { redactQuery } from '@/lib/search/trackingTerms';
import { TIERS } from '@/lib/search/tiers';
import { serverError } from '@/lib/routeError';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;
    const setup = requireOnboarded(user);
    if (setup) return setup;
    // Platform role: tenant data is not its to search, so there is nothing to log.
    if (user.role === 'SUPER_ADMIN') return NextResponse.json({ success: true });

    if (!searchTrackRateLimiter.check(user.id).success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const outcome = body?.outcome;
    if (query.length < 2 || query.length > 300 || (outcome !== 'clicked' && outcome !== 'no_result')) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const documentId = typeof body?.documentId === 'string' ? body.documentId : null;
    if (outcome === 'clicked' && (!documentId || !UUID.test(documentId))) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // An exact lookup of a sealed identifier is never logged, whatever it looks like.
    const tracked = redactQuery(query, { exactIdentifier: body?.exact === true });
    if (!tracked) return NextResponse.json({ success: true, logged: false });

    const resultCount = Math.max(0, Math.min(1000, Math.trunc(Number(body?.resultCount) || 0)));
    const matchedTier = TIERS.find((t) => t === body?.matchedIn) ?? null;

    let doc: {
      id: string; title: string; moduleKey: string | null; documentKey: string | null; companyId: string | null;
    } | null = null;
    if (outcome === 'clicked') {
      const found = await withTenant(user.tenantId, async (tx) =>
        tx.select({
          id: documents.id,
          title: documents.title,
          moduleKey: documents.categoryModuleKey,
          documentKey: documents.categoryDocumentKey,
          companyId: documents.companyId,
        })
          .from(documents)
          .where(and(
            eq(documents.tenantId, user.tenantId),
            eq(documents.id, documentId as string),
            visibleDocument(),
          ))
          .limit(1),
      );
      doc = found[0] ?? null;
      const allowed = doc
        && doc.moduleKey && doc.documentKey
        && await hasPermission(user, doc.moduleKey, 'view', doc.documentKey)
        && (doc.companyId ? await hasCompanyAccess(user, doc.companyId) : hasPersonalAccess(user));
      if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const categoryKey = doc?.moduleKey && doc.documentKey ? `${doc.moduleKey}/${doc.documentKey}` : null;
    const rows = tracked.terms.map((keyword) => ({
      tenantId: user.tenantId,
      keyword,
      documentId: doc?.id ?? null,
      documentTitle: doc?.title ?? null,
      categoryKey,
      companyId: doc?.companyId ?? null,
      lastQueryText: tracked.queryText,
      lastResultCount: resultCount,
      lastMatchedTier: matchedTier,
      lastUserId: user.id,
    }));
    // One row per (keyword, document), or per keyword when nothing was found —
    // the partial unique index that applies is chosen by `targetWhere`.
    const set = {
      hitCount: sql`${searchKeywords.hitCount} + 1`,
      lastAt: sql`now()`,
      documentTitle: doc?.title ?? null,
      categoryKey,
      companyId: doc?.companyId ?? null,
      lastQueryText: tracked.queryText,
      lastResultCount: resultCount,
      lastMatchedTier: matchedTier,
      lastUserId: user.id,
    };
    await withTenant(user.tenantId, async (tx) => {
      await tx.insert(searchKeywords).values(rows).onConflictDoUpdate(
        doc
          ? {
            target: [searchKeywords.tenantId, searchKeywords.keyword, searchKeywords.documentId],
            targetWhere: sql`${searchKeywords.documentId} IS NOT NULL`,
            set,
          }
          : {
            target: [searchKeywords.tenantId, searchKeywords.keyword],
            targetWhere: sql`${searchKeywords.documentId} IS NULL`,
            set,
          },
      );
    });

    return NextResponse.json({ success: true, logged: true });
  } catch (error) {
    return serverError(error, 'logging a search');
  }
}
