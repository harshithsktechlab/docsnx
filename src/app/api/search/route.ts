/**
 * Global search across every record the caller is allowed to see.
 *
 * Three things changed with consolidation, and the first two were bugs:
 *
 *  1. THERE WAS NO PERMISSION CHECK. The route authenticated and then searched
 *     eight tables, so a STANDARD user with no `passwords` permission still got
 *     password titles and usernames back. Every module is now filtered by
 *     `hasPermission`.
 *  2. It queried `documents` on `table.name`, a column migration 0013 renamed
 *     to `title`, so Drizzle threw and the route 500'd on every query.
 *  3. Eight hand-written `findMany` calls and eight result builders are now one
 *     query plus the record stores, which is also how the seven modules the old
 *     list simply omitted became searchable.
 *
 * ── WHAT IS SEARCHED ───────────────────────────────────────────────────────
 * The OPEN tier and the masked values — never the sealed tier, which the server
 * cannot read without decrypting every record. An exact-match lookup of a
 * sealed identifier goes through its blind index instead, so searching a full
 * account number still finds the account.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents, documentCategories, passwords } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPermission, hasPersonalAccess } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { requireOnboarded } from '@/lib/onboardingGate';
import { blindIndex } from '@/lib/fieldCrypto';
import { readJsonStore } from '@/lib/vault/vaultRecords';
import { pathForCategory } from '@/lib/records/registry';
import { utilityNavPath } from '@/lib/moduleRegistry';
import { type CategoryKey, categoryLabel } from '@/lib/documentCategories';
import { activeCategoryKeys, moduleNames } from '@/lib/taxonomyRegistry';
import { visibleDocument } from '@/lib/records/documentVisibility';

import { serverError } from '@/lib/routeError';

const MAX_RESULTS_PER_MODULE = 10;

/**
 * The page a hit links to — the one that owns that CATEGORY, not a slugified
 * module name. A module can be reached from more than one page (Bank &
 * Investments is /bank-info, /trading, /investments and /loans-debt), so the
 * link has to be resolved per category or half the results point somewhere the
 * record is not listed.
 */
/**
 * Where a hit opens.
 *
 * A personal hit goes to the SCOPE that owns the category — the bespoke page a
 * user knows it by. A business hit cannot: a business scope's static `path`
 * carries the literal `:companyId` placeholder (it is a compile-time
 * description, and the company is only known per request), so it is built here
 * from the company the row actually belongs to. Linking a business hit at
 * `/modules/...` would open a route that 400s — a business module addressed
 * with no company.
 */
const linkFor = (key: CategoryKey, companyId?: string | null) => (
  companyId
    ? `/business/${companyId}/modules/${key.moduleKey}/${key.documentKey}`
    : pathForCategory(key) ?? '/documents'
);

/**
 * Module display names, straight off the taxonomy.
 *
 * Resolved per request rather than at module load: a result can be filed under a
 * module an operator added since this process started, and labelling it with its
 * raw key would show the user `property_legal` where every other row says
 * "Property & Legal".
 */

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;
    // Search reads across every module at once, so it does not pass through
    // either of the two gates in `records/` — it needs the setup gate of its own.
    const setup = requireOnboarded(user);
    if (setup) return setup;

    // Platform role: tenant data is not its to search.
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ success: true, results: [] });
    }

    const query = (new URL(req.url).searchParams.get('q') || '').trim();
    if (query.length < 2) return NextResponse.json({ success: true, results: [] });

    const needle = query.toLowerCase();
    // Exact-match handle for sealed identifiers. Searching a full account number
    // finds the account without the server ever reading the stored value.
    const queryHash = blindIndex(query);

    // Only the CATEGORIES this user may view, resolved once before any query.
    // Per sub-category since 0024: a member denied one category of a module must
    // not find its records through search either.
    const LABELS = await moduleNames();
    const permitted = new Set<string>();
    for (const row of await activeCategoryKeys()) {
      if (await hasPermission(user, row.moduleKey, 'view', row.documentKey)) {
        permitted.add(categoryLabel(row));
      }
    }
    if (permitted.size === 0) return NextResponse.json({ success: true, results: [] });

    const rows = await withTenant(user.tenantId, async (tx) =>
      tx.select({
        id: documents.id,
        title: documents.title,
        module: documents.categoryModuleKey,
        documentKey: documents.categoryDocumentKey,
        categoryName: documentCategories.documentName,
        fileName: documents.fileName,
        // Which vault holds this record's contents, and which workspace its
        // link has to open.
        companyId: documents.companyId,
      })
        .from(documents)
        .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
        .where(and(
          eq(documents.tenantId, user.tenantId),
          /**
           * ── SEARCH SPANS EVERY WORKSPACE THE MEMBER CAN REACH ─────────────
           *
           * Deliberately NOT scoped to one company. Spotlight is the "where did
           * I put that" surface, and a person who holds two companies and a
           * household does not know which of the three a document is in — that
           * is the question they are asking. Making them choose first would be
           * asking them to answer it.
           *
           * What that costs is a company column on every row, a
           * `hasCompanyAccess` check per company below, and a store read per
           * (company, category) rather than per category. All three are done.
           */
          visibleDocument(),
        )),
    );

    /**
     * The COMPANY grain, cached so a workspace with five companies asks five
     * times rather than once per category.
     *
     * Not optional on a read-only surface: search returns a record's TITLE and
     * its category, which is most of what the record says. A member with no
     * grant on Acme must not learn Acme's document titles by typing a word.
     *
     * ── AND `null` IS A WORKSPACE TOO ────────────────────────────────────────
     * It used to return `true` unconditionally, which is the same mistake
     * `resolveUtilityCompany` made and is worse here: this route sweeps EVERY
     * workspace by design, so a business member needed to name nothing at all —
     * they typed a word and got the household's password titles and usernames
     * back. `hasPersonalAccess` is the household's half of this question.
     */
    const companyAllowed = new Map<string, boolean>();
    const mayReach = async (companyId: string | null): Promise<boolean> => {
      if (!companyId) return hasPersonalAccess(user);
      const cached = companyAllowed.get(companyId);
      if (cached !== undefined) return cached;
      const allowed = await hasCompanyAccess(user, companyId);
      companyAllowed.set(companyId, allowed);
      return allowed;
    };

    // Narrowed to rows that actually carry a category, so the store key below
    // is built from real values rather than assertions.
    const withCategory = rows.flatMap((r) =>
      r.module && r.documentKey && permitted.has(`${r.module}/${r.documentKey}`)
        ? [{ ...r, module: r.module, documentKey: r.documentKey }]
        : []);
    const visible = [];
    for (const r of withCategory) {
      if (await mayReach(r.companyId ?? null)) visible.push(r);
    }

    // One store read per (COMPANY, module, category) actually present. The
    // company is part of the key because two companies filing into the same
    // category hold two separate encrypted stores — keying on the category
    // alone would open whichever came first and search it for both.
    const stores = new Map<string, {
      module: string; key: CategoryKey; companyId: string | null; rows: any[];
    }>();
    for (const r of visible) {
      const companyId = r.companyId ?? null;
      const k = `${companyId ?? ''}|${r.module}/${r.documentKey}`;
      const e = stores.get(k);
      if (e) e.rows.push(r);
      else stores.set(k, {
        module: r.module,
        key: { moduleKey: r.module, documentKey: r.documentKey },
        companyId,
        rows: [r],
      });
    }

    const perModule = new Map<string, any[]>();

    for (const { module: mod, key, companyId, rows: storeRows } of stores.values()) {
      const ctx = {
        tenant: user.tenant, tenantId: user.tenantId, userId: user.id, companyId,
      };
      let records: Record<string, any> = {};
      try {
        const { store } = await readJsonStore(ctx as any, mod as any, key);
        records = store.records ?? {};
      } catch {
        // Unreadable store: fall through and match on the row's own title.
      }

      for (const row of storeRows) {
        const record = records[row.id];
        const haystack = [
          row.title, row.fileName, row.categoryName,
          record?.issuer,
          JSON.stringify(record?.open ?? {}),
          JSON.stringify(record?.masked ?? {}),
        ].join(' ').toLowerCase();

        const hashes: Record<string, string> = record?.searchHashes ?? {};
        const exactHit = Boolean(queryHash) && Object.values(hashes).includes(queryHash as string);

        if (!exactHit && !haystack.includes(needle)) continue;

        const bucket = perModule.get(mod) ?? [];
        if (bucket.length >= MAX_RESULTS_PER_MODULE) continue;
        bucket.push({
          id: `${mod}-${row.id}`,
          title: record?.name ?? row.title,
          subtitle: [row.categoryName, record?.issuer].filter(Boolean).join(' — ')
            || LABELS.get(mod) || mod,
          // Into the workspace the record actually lives in. A business hit
          // linked at `/modules/...` would open a route that 400s.
          link: `${linkFor(key, companyId)}?search=${encodeURIComponent(query)}`,
          module: LABELS.get(mod) || mod,
          // An exact identifier match is what the user was most likely after.
          exact: exactHit,
        });
        perModule.set(mod, bucket);
      }
    }

    // Passwords keep their own table and their own permission.
    if (await hasPermission(user, 'passwords', 'view')) {
      const pwRows = await withTenant(user.tenantId, async (tx) =>
        tx.select({
          id: passwords.id,
          title: passwords.title,
          username: passwords.username,
          category: passwords.category,
          // Which account each credential belongs to. Selected rather than
          // constrained, because search spans the workspaces this member can
          // reach — exactly as the document arm above does — and each hit then
          // links back into the account it actually lives in.
          companyId: passwords.companyId,
        })
          .from(passwords)
          .where(and(
            eq(passwords.tenantId, user.tenantId),
            isNull(passwords.deletedAt),
          )),
      );

      /**
       * Reachability, not just permission.
       *
       * `passwords.view` says the member may use the module; it says nothing
       * about WHICH company's vault. Without this filter a business member with
       * the module would find the household's credentials here — the one place
       * the two accounts must never blur — and a member of company A would find
       * company B's. `mayReach` is the same cached `hasCompanyAccess` the
       * document arm uses, and it returns true for the personal account.
       */
      const reachable: any[] = [];
      for (const p of pwRows) {
        if (await mayReach(p.companyId ?? null)) reachable.push(p);
      }

      const hits = reachable
        .filter((p: any) => `${p.title} ${p.username} ${p.category}`.toLowerCase().includes(needle))
        .slice(0, MAX_RESULTS_PER_MODULE)
        .map((p: any) => ({
          id: `password-${p.id}`,
          title: p.title,
          subtitle: `Username: ${p.username} (${String(p.category || '').toUpperCase()})`,
          // The company's own page when it is a company's credential, so the
          // link lands in the workspace that holds it. Same builder the sidebar
          // uses, so the two cannot drift.
          link: `${utilityNavPath('/passwords', p.companyId ?? null)}?search=${encodeURIComponent(query)}`,
          module: 'Passwords',
          exact: false,
        }));
      if (hits.length) perModule.set('passwords', hits);
    }

    const results = [...perModule.values()].flat()
      .sort((a, b) => Number(b.exact) - Number(a.exact));

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return serverError(error, 'searching');
  }
}
