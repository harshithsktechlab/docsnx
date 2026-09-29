/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DASHBOARD OF ONE WORKSPACE                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `GET /api/dashboard` is the household's. `?companyId=<id>` makes it that
 * company's. One handler, because the two pages are one component and every
 * number on them is the same question asked of a different account.
 *
 * ── WHY THIS ROUTE USED TO BE HOUSEHOLD-ONLY, AND WHY IT ISN'T ─────────────
 * It shipped with `inCompany(null)` hard-coded and a company workspace that had
 * no dashboard to serve. That left the passwords tally below with no company
 * predicate at all — nothing on the page needed one — so a household holding one
 * credential and a company holding one rendered "2" on the household's card.
 * There is no RLS on this axis (both rows carry the same `tenant_id`), so that
 * count was the only control there was, and it was disclosing across accounts
 * while looking like an ordinary off-by-one.
 *
 * Hence the rule this file now follows without exception: EVERY tally takes
 * `scope.companyId`, and `scope` comes from `resolveUtilityCompany` — never from
 * `companyIdFromRequest`, which is the raw read with no `hasCompanyAccess`
 * behind it.
 *
 * ── A TILE'S NUMBER IS WHAT ITS PAGE LISTS ─────────────────────────────────
 * The one invariant every count here answers to. It is why the grouped query
 * carries the permission predicate (a tile must not count records the page
 * behind it filters out), and why `documents` is the workspace total rather
 * than the `documents` scope — see the note on that field below.
 */
import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import {
  documents, passwords, todos, emergencyContacts, companies, companyProfiles,
  profiles, users, tenants, auditLogs,
} from '@/db/schema';
import { eq, and, desc, count, isNull } from 'drizzle-orm';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { categoryIdIn, inCompany, permittedCategories } from '@/lib/records/handler';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { keysForWorkspace } from '@/lib/documentCategories';
import { mirrorsOf } from '@/lib/categoryMirrors';
import { scopeForCategory } from '@/lib/records/registry';
import { serverError } from '@/lib/routeError';
import { todoVisibilityCondition } from '@/lib/todoNotify';
import { allFilled, type SetupFacts } from '@/lib/setupChecklist';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    if (user.role === 'SUPER_ADMIN') {
      const [
        [{ value: tenantCount }],
        [{ value: userCount }],
      ] = await Promise.all([
        db.select({ value: count() }).from(tenants),
        db.select({ value: count() }).from(users),
      ]);

      // No audit feed for SUPER_ADMIN. This previously read the 5 newest rows
      // with no tenant filter at all, giving the platform role a cross-tenant
      // view of every tenant's activity. Audit logs are TENANT_ADMIN-only.
      return NextResponse.json({
        success: true,
        userName: user.name,
        tenantName: 'System Admin',
        isAdminDashboard: true,
        stats: {
          tenants: tenantCount,
          users: userCount,
          apiKeys: 0,
        },
        recentLogs: [],
      });
    }

    /**
     * WHICH account this dashboard is.
     *
     * The utility gate, not the record gate: a dashboard belongs to a workspace
     * rather than to a module, so "no company" is the household and a
     * legitimate answer. The company is PROVEN here, once, and every predicate
     * below is built from the proven value.
     */
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;
    const { companyId } = scope;

    /**
     * The categories this member may see, narrowed to THIS workspace's half of
     * the taxonomy.
     *
     * Both halves matter. Without the permission filter a tile counts records
     * the page behind it hides, so a denied member reads a number they cannot
     * reconcile with anything. Without `keysForWorkspace` the personal grouped
     * query would take `biz_*` categories into its tallies — which the company
     * predicate already excludes row-wise, but stating it here is what keeps
     * `stats.documents` equal to what the Document Manager lists, since that
     * route narrows exactly the same way (src/app/api/documents/route.ts).
     *
     * `hasPermission` is in-memory (the permissions ride on the session user),
     * so this is one category read, not one query per category.
     */
    const viewable = keysForWorkspace(await permittedCategories(user, 'view'), companyId);

    // Counts are of live records only — soft-deleted rows must not be tallied.
    //
    // ONE grouped query where there were six. Every module's records are
    // `documents` rows now, so counting them separately meant five queries over
    // tables that are empty.
    //
    // Grouped by the CATEGORY pair, not by module: the dashboard's tiles are
    // per PAGE, and since 0023 a page can span two modules (/investments is
    // bank_investments + property_legal) while a module can be reached from
    // four. Only the pair maps unambiguously to a tile.
    const grouped = viewable.length === 0 ? [] : await withTenant(user.tenantId, async (tx) =>
      tx.select({
        moduleKey: documents.categoryModuleKey,
        documentKey: documents.categoryDocumentKey,
        value: count(),
      })
        .from(documents)
        // ONE workspace's records, never both. A company's numbers belong on its
        // own dashboard at /business/<companyId>, and the household's on this
        // one; the company here is the proven one, never a value off the URL.
        .where(and(
          eq(documents.tenantId, user.tenantId),
          inCompany(companyId),
          await categoryIdIn(viewable),
          visibleDocument(),
        ))
        .groupBy(documents.categoryModuleKey, documents.categoryDocumentKey),
    );
    /**
     * The two tallies answer DIFFERENT questions, and a tile has to pick the
     * one its link implies:
     *
     *   byModule          what does this PAGE own? Keyed by scope. /documents
     *                     is a page, not a module, and its tile reads this.
     *   byTaxonomyModule  what does `/modules/<moduleKey>` DISPLAY? Which
     *                     includes what that module mirrors, below.
     *
     * A scope-keyed count on a tile that opens a module page disagrees with the
     * page it opens: /investments is three of Bank & Investments' categories
     * plus five of Property & Legal's, so its number matches neither module.
     */
    const byModule = new Map<string, number>();
    const byTaxonomyModule = new Map<string, number>();
    const addModule = (moduleKey: string, value: number) => {
      byTaxonomyModule.set(moduleKey, (byTaxonomyModule.get(moduleKey) ?? 0) + value);
    };

    /**
     * Every record in this workspace, counted once.
     *
     * Summed from the RAW grouped rows, deliberately — not from `byTaxonomyModule`,
     * which deliberately reports a mirrored record under both modules that
     * display it. Summing that map would turn "one fact stated twice" into a
     * total claiming records the workspace does not hold.
     */
    let workspaceTotal = 0;

    for (const g of grouped as any[]) {
      if (!g.moduleKey || !g.documentKey) continue;
      const key = { moduleKey: g.moduleKey, documentKey: g.documentKey };
      const value = Number(g.value);

      workspaceTotal += value;
      addModule(g.moduleKey, value);
      /**
       * ── A MIRRORED CATEGORY IS DISPLAYED BY TWO MODULES ──────────────────
       *
       * A motor policy is stored once, under `insurance/vehicle_policies`, and
       * the Vehicle module lists it too (src/lib/categoryMirrors.ts). Both
       * modules' pages show it, so both modules' tiles must count it, or the
       * Vehicle tile reports zero and opens a page holding a record.
       *
       * This is NOT a double count. The record exists exactly once — one row,
       * one Drive object — and appearing in two modules' totals is that one
       * fact stated from two places, not two records. What it does mean is that
       * the tiles no longer sum to the document total, which is why nothing
       * sums them.
       *
       * `mirrorsOf` is asked of the CANONICAL pair, which is what every row
       * carries, and an alias is always in a different module from its
       * canonical (asserted by tests/categoryMirrors.test.ts) — so this can
       * never add the same rows to one module twice.
       */
      for (const alias of mirrorsOf(key)) addModule(alias.moduleKey, value);

      const scope = scopeForCategory(key);
      if (!scope) continue;
      byModule.set(scope, (byModule.get(scope) ?? 0) + value);
    }

    /**
     * ── THE THREE UTILITIES ────────────────────────────────────────────────
     *
     * Passwords, to-dos and contacts keep their own tables — they are not record
     * modules — so each needs the company predicate spelled out separately.
     * `inCompanyOf`, never `eq(column, null)`: in SQL `company_id = NULL` is NULL
     * and matches no row, so the household's card would silently read zero.
     *
     * Each is gated the way `/api/todos/count` gates its badge: a member without
     * the module gets a zero rather than a 403, because the caller is a card on
     * a page that must still render.
     */
    const todoVisibility = todoVisibilityCondition(user);

    const [passwordCount, todoCount, contactCount] = await withTenant(user.tenantId, async (tx) => Promise.all([
      await hasPermission(user, 'passwords', 'view')
        ? tx.$count(passwords, and(
          eq(passwords.tenantId, user.tenantId),
          inCompanyOf(passwords.companyId, companyId),
          isNull(passwords.deletedAt),
        ))
        : 0,
      // PENDING only — the one string the to-dos page filter, the follow-up
      // Tasks tab and the header badge all agree on. `todos` has no `deletedAt`.
      // Also excludes a task hidden from this user under `todoVisibilityCondition`
      // (self-created, self-assigned by someone else) — same rule as the badge.
      await hasPermission(user, 'todos', 'view')
        ? tx.$count(todos, and(
          eq(todos.tenantId, user.tenantId),
          inCompanyOf(todos.companyId, companyId),
          eq(todos.status, 'PENDING'),
          ...(todoVisibility ? [todoVisibility] : []),
        ))
        : 0,
      await hasPermission(user, 'emergency_contacts', 'view')
        ? tx.$count(emergencyContacts, and(
          eq(emergencyContacts.tenantId, user.tenantId),
          inCompanyOf(emergencyContacts.companyId, companyId),
        ))
        : 0,
    ]));

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      // `googleDriveEnabled` joins `name` for the setup checklist below. Two
      // columns off a row this route already reads — not a second query, and
      // deliberately NOT `columns` omitted: the row carries `apiKey` and the
      // Drive OAuth tokens, and this payload is sent to every member.
      columns: { name: true, googleDriveEnabled: true },
    });

    /**
     * What the page's header calls this workspace.
     *
     * The company's own name, so switching companies visibly changes the page —
     * without it every company workspace headed itself with the tenant's name
     * and the five of them read identically. Scoped to the tenant and to live
     * rows even though `hasCompanyAccess` has already passed: the lookup is a
     * query like any other and gets the same predicates.
     */
    const [company] = companyId
      ? await withTenant(user.tenantId, (tx) => tx
        .select({ name: companies.name })
        .from(companies)
        .where(and(
          eq(companies.id, companyId),
          // Scoped by the SESSION's tenant, so an id from another workspace
          // simply does not resolve — the same lookup `/api/companies/[id]`
          // does, inside the same RLS session.
          eq(companies.tenantId, user.tenantId),
          isNull(companies.deletedAt),
        ))
        .limit(1))
      : [null];

    /**
     * ── WHAT IS STILL MISSING FROM THIS WORKSPACE ──────────────────────────
     *
     * The facts behind the dashboard's completion panel. The panel used to
     * compute itself from the record counts above and call the result a
     * profile, so a member with every profile field blank read "50% Done" for
     * having uploaded one file. The rules live in src/lib/setupChecklist.ts;
     * this block answers the questions they ask, from the database.
     *
     * ⚠ BOOLEANS LEAVE THIS ROUTE, NEVER VALUES. `legal_details.panNumber` and
     * `tax_details.gstNumber` are ciphertext at rest and stay there: "is it
     * filled in" is answerable from presence alone, and shipping the values so
     * the browser could check them would put an Aadhaar number in every cache
     * and error report to draw a progress bar. Nothing here decrypts.
     */
    const canProfiles = await hasPermission(user, 'profiles', 'view');

    // ONE row, for the account this dashboard is — never both.
    const [ownProfile, companyProfile] = await Promise.all([
      // The caller's OWN profile, by their own id. `profiles` carries no
      // `tenant_id` and is in neither RLS list (scripts/apply-rls.js); it is
      // reached through `user_id`, which is exactly how /api/profiles scopes
      // it. No `userId` off the request — this is the signed-in member's panel.
      !companyId && canProfiles
        ? db.query.profiles.findFirst({
          where: eq(profiles.userId, user.id),
          columns: { personalDetails: true, legalDetails: true },
        })
        : null,
      // `company_profiles` IS tenant-scoped RLS, so it gets both halves of
      // AGENTS.md §6 — the `withTenant` session var and the explicit predicate
      // — and the PROVEN `companyId` from `resolveUtilityCompany`, never the
      // raw value off the query string.
      companyId && canProfiles
        ? withTenant(user.tenantId, async (tx) => {
          const [row] = await tx
            .select({
              identityDetails: companyProfiles.identityDetails,
              taxDetails: companyProfiles.taxDetails,
              addressDetails: companyProfiles.addressDetails,
              contactDetails: companyProfiles.contactDetails,
            })
            .from(companyProfiles)
            .where(and(
              eq(companyProfiles.companyId, companyId),
              eq(companyProfiles.tenantId, user.tenantId),
              isNull(companyProfiles.deletedAt),
            ))
            .limit(1);
          return row ?? null;
        })
        : null,
    ]);

    const identity = (companyProfile?.identityDetails ?? null) as Record<string, unknown> | null;
    const setup: SetupFacts = {
      driveConnected: !!tenant?.googleDriveEnabled,
      hasDocuments: workspaceTotal > 0,
      profile: {
        personal: allFilled(
          (ownProfile?.personalDetails ?? null) as Record<string, unknown> | null,
          ['dob', 'gender', 'bloodGroup'],
        ),
        // The passport is not asked for — plenty of people do not hold one, and
        // a row nobody can finish is worse than no row.
        legal: allFilled(
          (ownProfile?.legalDetails ?? null) as Record<string, unknown> | null,
          ['panNumber', 'aadhaarNumber'],
        ),
      },
      company: {
        identity: allFilled(identity, ['legalName', 'entityType']),
        registration: allFilled(identity, ['registrationNumber', 'incorporatedOn']),
        // TAN is genuinely optional — an entity that deducts no tax at source
        // has none — so it is not asked for.
        tax: allFilled(
          (companyProfile?.taxDetails ?? null) as Record<string, unknown> | null,
          ['gstNumber', 'panNumber'],
        ),
        address: allFilled(
          (companyProfile?.addressDetails ?? null) as Record<string, unknown> | null,
          ['registeredAddress'],
        ),
        contact: allFilled(
          (companyProfile?.contactDetails ?? null) as Record<string, unknown> | null,
          ['email', 'phone'],
        ),
      },
      can: {
        // Granting Drive is the tenant admin's to do; a member offered the
        // button gets a 403 and a score they can never finish.
        drive: user.role === 'TENANT_ADMIN',
        profiles: canProfiles,
        // `viewable` empty means the Document Manager lists nothing for this
        // member, so "upload your first document" is not theirs to do either.
        documents: viewable.length > 0,
      },
    };

    return NextResponse.json({
      success: true,
      userName: user.name,
      // Kept as the TENANT's name whichever workspace this is — it is what the
      // account is called, and other callers read it as that.
      tenantName: tenant?.name || 'My Workspace',
      /** Which account this payload describes, for the header and for tests. */
      companyId,
      workspaceName: companyId
        ? (company?.name || 'Company')
        : (tenant?.name || 'My Workspace'),
      stats: {
        /**
         * ── THE DOCUMENTS TILE COUNTS THE WHOLE WORKSPACE ──────────────────
         *
         * It used to read `byModule.get('documents')`, the `documents` SCOPE:
         * identity, education, civil_government and the catch-all. But the tile
         * opens `/documents`, the Document Manager, and that page is the one
         * view that spans the entire taxonomy — it lists every category the
         * member may view, in this workspace (src/app/api/documents/route.ts).
         *
         * So the scope-keyed number described four modules on a tile that
         * opened all of them: a household with a PAN card and three vehicle
         * records read "1" above a page listing four. The workspace total is
         * what that page shows, and `viewable` above is the same narrowing the
         * page applies, so the two now agree by construction.
         *
         * The consequence to expect: this number is larger than it was, and it
         * is larger than any module tile beside it. That is the correct
         * relationship — the manager is a superset of every module.
         */
        documents: workspaceTotal,
        // The three below are per MODULE, not per scope: their tiles open
        // `/modules/<key>`, so they must count what that page shows.
        //
        // `medical` and `vehicles` used to read the scope. For Medical the two
        // are equal — the scope owns exactly the six health_medical categories
        // and nothing else owns one — so that was a latent defect rather than a
        // live one. For Vehicles it was live: the scope excluded the mirrored
        // motor policies the module page displays, so the tile read zero and
        // opened a page with records on it.
        medical: byTaxonomyModule.get('health_medical') ?? 0,
        passwords: Number(passwordCount),
        // The two the company dashboard cards read. Personal has them too —
        // they cost one `$count` each and the household has the same tasks and
        // contacts — but its card row is unchanged and simply ignores them.
        todos: Number(todoCount),
        contacts: Number(contactCount),
        vehicles: byTaxonomyModule.get('vehicle') ?? 0,
        investments: byModule.get('investments') ?? 0,
        bankInvestments: byTaxonomyModule.get('bank_investments') ?? 0,
        licMediclaim: byModule.get('lic_mediclaim') ?? 0,
        // Now free, because they come from the same grouped query.
        bankInfo: byModule.get('bank_info') ?? 0,
        trading: byModule.get('trading') ?? 0,
        warranty: byModule.get('warranty') ?? 0,
        rentals: byModule.get('rentals') ?? 0,
        utilityBills: byModule.get('utility_bills') ?? 0,
        taxCompliance: byModule.get('tax_compliance') ?? 0,
        loansDebt: byModule.get('loans_debt') ?? 0,
        willsEstate: byModule.get('wills_estate') ?? 0,
        employmentPayroll: byModule.get('employment_payroll') ?? 0,
        /**
         * Every module's own count, keyed by module key.
         *
         * Kept though no screen reads it today: it was the company dashboard's
         * module grid, which is gone — the rail and the More tab are where a
         * workspace's modules are listed now. It stays because it costs one
         * `Object.fromEntries` over a map the tiles above already build, and
         * because the alternative for whatever wants these next is fourteen
         * requests to `/api/modules/<key>/counts`, each opening that module's
         * stores on Drive.
         *
         * Read from `byTaxonomyModule`, so a count agrees with the module page
         * it describes (mirrors included) rather than with the scope behind it
         * — the rule `tests/dashboardCounts.test.ts` pins.
         */
        modules: Object.fromEntries(byTaxonomyModule),
      },
      /** Booleans only — see the block that builds it. */
      setup,
      reminders: [],
      recentLogs: [],
    });
  } catch (error) {
    return serverError(error, 'loading dashboard statistics');
  }
}
