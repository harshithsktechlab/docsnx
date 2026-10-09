import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { users, profiles, permissions, companies, companyAccess } from '@/db/schema';
import { eq, and, ne, or, sql, count, isNull, inArray } from 'drizzle-orm';
import { getUserFromRequest, hashPassword } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { memberQuota } from '@/lib/billingAxis';
import { activeAddonSeats, seatPredicate } from '@/lib/account/seatCounts';
import { parseQueryParams, buildListQueryHelper } from '@/lib/api-pagination';
import { validateUserContacts } from '@/lib/userContactValidation';
import { toDialString, isBlankPhone } from '@/lib/phone';
import {
  isDuplicatePhone, DUPLICATE_PHONE_MESSAGE,
  isDuplicateEmail, DUPLICATE_EMAIL_MESSAGE,
} from '@/lib/dbErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { defaultPermissionsFor } from '@/lib/moduleRegistry';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;
    if (user.role !== 'TENANT_ADMIN' && user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin access required.' }, { status: 403 });
    }

    /**
     * ── THE ROSTER FOLLOWS THE WORKSPACE ──────────────────────────────────
     *
     * `?companyId=` absent is the household; present and proven is one company.
     * Through the same gate every other shared utility uses, so a company that
     * is not this caller's is a 403 here exactly as it is on /api/passwords —
     * and never a 404, which would let a member enumerate the tenant's
     * companies.
     *
     * A SUPER_ADMIN is exempt: `hasCompanyAccess` refuses the platform role
     * outright, so asking it about a workspace is meaningless. It never reaches
     * this page anyway — /users is in TENANT_SPECIFIC_PATHS.
     */
    let workspaceCompanyId: string | null = null;
    if (user.role !== 'SUPER_ADMIN') {
      const scope = await resolveUtilityCompany(req, user);
      if ('error' in scope) return scope.error;
      workspaceCompanyId = scope.companyId;
    }

    const params = parseQueryParams(req);
    const { limit, offset, orderBy, searchFilter } = buildListQueryHelper(users, params, [
      users.name,
      users.email,
      users.phoneNumber
    ]);

    // Base conditions
    const baseConditions = [
      eq(users.tenantId, user.tenantId),
      ne(users.role, 'SUPER_ADMIN'),
      // A removed member's row is RETAINED so their records keep a resolvable
      // holder and their audit trail survives (see lib/account/memberRemoval.ts).
      // They are not a member any more, so they must not appear in this list.
      isNull(users.deletedAt),
    ];

    if (searchFilter) {
      baseConditions.push(searchFilter);
    }

    if (params.filters.role) {
      baseConditions.push(eq(users.role, params.filters.role as any));
    }

    const { total: totalCountResult, rows: tenantUsers, grantsByUser } = await withTenant(user.tenantId, async (tx) => {
      /**
       * ── WHICH MEMBERS BELONG TO THIS WORKSPACE ───────────────────────────
       *
       * Personal: everyone added to the household. `account_scope` is the
       * stored answer to the question the Add-member screen has always asked;
       * see the comment on the column in src/db/schema.ts, and note that it is
       * NOT the permission gate — it decides which list someone appears in.
       *
       * A company: the members granted THIS company, and nobody else's. The
       * grant is read here rather than joined so the count query and the page
       * query cannot diverge.
       *
       * A TENANT_ADMIN is listed in every workspace whether or not a grant row
       * says so: `hasCompanyAccess` short-circuits for them, so a roster that
       * hid them would be a list that visibly lies. This predicate is where
       * that rule now lives — the per-company access checklist that used to
       * state it a second way is gone, and with it the chance of the two
       * disagreeing.
       */
      if (workspaceCompanyId) {
        const grants = await tx
          .select({ userId: companyAccess.userId })
          .from(companyAccess)
          .where(eq(companyAccess.companyId, workspaceCompanyId));
        const grantedIds = grants.map((g: any) => g.userId);
        baseConditions.push(
          grantedIds.length
            ? or(eq(users.role, 'TENANT_ADMIN'), inArray(users.id, grantedIds))!
            : eq(users.role, 'TENANT_ADMIN'),
        );
      } else if (user.role !== 'SUPER_ADMIN') {
        baseConditions.push(
          or(eq(users.role, 'TENANT_ADMIN'), eq(users.accountScope, 'personal'))!,
        );
      }

      const whereClause = and(...baseConditions);
      const [total] = await tx.select({ count: count() }).from(users).where(whereClause);
      
      const data = await tx.query.users.findMany({
        where: whereClause,
        orderBy: orderBy,
        limit: limit,
        offset: offset,
        with: {
          permissions: true,
          profile: true,
        },
      });

      /**
       * ── WHICH COMPANIES EACH OF THEM WORKS ON ────────────────────────────
       *
       * For the "Also works on" checklist on the member screen, which is the
       * only place a grant can be changed now that the per-company checklist
       * is gone. A member of this account may hold more than one company, and
       * the screen cannot show what it was never told.
       *
       * ONE query for the page rather than one per row, and only inside a
       * company workspace — the household roster has no company grain and
       * would be paying for an answer nothing on that screen reads.
       *
       * An explicit select rather than an eager load: `usersRelations` carries
       * no `companyAccess`, and adding one would put a join on every route
       * that reads a user with its permissions.
       */
      const grantsByUser = new Map<string, string[]>();
      if (workspaceCompanyId && data.length > 0) {
        const held = await tx
          .select({ userId: companyAccess.userId, companyId: companyAccess.companyId })
          .from(companyAccess)
          .where(inArray(companyAccess.userId, data.map((u: any) => u.id)));
        for (const row of held as any[]) {
          const list = grantsByUser.get(row.userId);
          if (list) list.push(row.companyId);
          else grantsByUser.set(row.userId, [row.companyId]);
        }
      }

      return { total, rows: data, grantsByUser };
    });

    const totalCount = totalCountResult.count;
    const totalPages = Math.ceil(totalCount / limit);

    // ── STRIP EVERY STORED SECRET, NOT JUST THE PASSWORD ────────────────────
    // These rows go to a tenant admin's browser. The password hash was already
    // removed; the OTP and reset-token columns were not, so the list has been
    // shipping `hashToken()` digests of live one-time codes to the client. They
    // are not reversible, but they are the stored form of a bearer secret and
    // nothing on the screen needs them — and 0052 would otherwise have added a
    // second one to the payload.
    const safeUsers = tenantUsers.map(u => {
      const {
        passwordHash,
        emailVerificationOtp, phoneVerificationOtp,
        resetToken,
        ...safe
      } = u;
      // An admin holds no rows — `hasCompanyAccess` short-circuits for them —
      // so theirs is empty here and the member screen does not offer them a
      // checklist that could not take anything away.
      return { ...safe, companyIds: grantsByUser.get(u.id) ?? [] };
    });

    return NextResponse.json({ 
      success: true, 
      users: safeUsers,
      pagination: {
        page: params.page,
        limit,
        totalCount,
        totalPages
      }
    });
  } catch (error) {
    return serverError(error, 'listing users');
  }
}

export async function POST(req: Request) {
  try {
    const currentUser = await getUserFromRequest(req);
    if (!currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;
    if (currentUser.role !== 'TENANT_ADMIN' && currentUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin access required.' }, { status: 403 });
    }

    const {
      name, email, password, phoneNumber, role, permissions: reqPermissions,
      dob, anniversaryDate,
      /**
       * Which account this member belongs to: 'personal' | 'business'.
       *
       * It decides which half of the taxonomy they are seeded with, and that
       * seeding IS the enforcement — `hasPermission` denies outright when no row
       * matches, so a business member with no personal rows is refused every
       * personal module. There is no second gate to forget.
       */
      accountScope: reqAccountScope,
      /** Companies a BUSINESS member may reach. Ignored for a personal one. */
      companyIds: reqCompanyIds,
    } = await req.json();

    /**
     * ── THE WORKSPACE ANSWERS THE QUESTION THE FORM USED TO ASK ─────────────
     *
     * Adding a member from inside Acme adds them TO Acme. The Add-member dialog
     * no longer carries a "personal or business?" radio button, because the
     * admin already answered it by being where they are.
     *
     * The two body fields above are kept for the personal workspace (where an
     * admin may still hand-pick companies) and for API callers that predate
     * this, but the company on the request wins when there is one.
     */
    const scope = currentUser.role === 'SUPER_ADMIN'
      ? { companyId: null as string | null }
      : await resolveUtilityCompany(req, currentUser);
    if ('error' in scope) return scope.error;
    const workspaceCompanyId = scope.companyId;

    if (role === 'SUPER_ADMIN' && currentUser.role === 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Tenant Admins cannot create Super Admin users.' }, { status: 403 });
    }

    if (!name || !password) {
      return NextResponse.json({ error: 'Name and Password are required' }, { status: 400 });
    }

    const newRole = (role as any) || 'STANDARD';

    const contactCheck = validateUserContacts({
      role: newRole,
      email,
      phoneNumber,
    });
    if (!contactCheck.isValid) {
      const errorMsg = contactCheck.errors.phoneNumber || contactCheck.errors.email || 'Invalid contact details';
      return NextResponse.json({ error: errorMsg }, { status: 400 });
    }

    // No delivery check here any more. A member is created WITHOUT sign-in
    // (see `signInDisabledAt` below), so nothing is sent and nothing needs to
    // be deliverable yet. Whether a code can reach them is checked when the
    // admin gives them access — POST /api/users/[id]/sign-in.

    // Optional for a member since 0040, so it may legitimately be absent. Kept
    // as null rather than '' — the partial unique index treats NULLs as
    // non-colliding, but a second empty string would be a duplicate.
    const cleanEmail = String(email || '').trim().toLowerCase() || null;

    /**
     * ── WHICH ACCOUNT THIS MEMBER IS BEING ADDED TO ──────────────────────────
     *
     * Resolved from the tenant, not taken on trust. A `personal` workspace has
     * no business side to add anyone to and a `business` one has no personal
     * side, so in both cases the answer is forced and a request asking for the
     * other is simply corrected rather than refused — the caller cannot express
     * anything meaningful there.
     *
     * Only a `both` tenant genuinely has a choice, and it defaults to
     * 'personal': that is what every workspace was before the business account
     * existed, and it is the safe direction to be wrong in — forgetting to
     * grant is a support request, forgetting to revoke is a disclosure.
     */
    const tenantAccountType = (currentUser as any).tenant?.accountType ?? 'personal';
    const accountScope =
      // Standing in a company workspace is the least ambiguous answer there is,
      // and it outranks both the tenant's shape and the body — the company was
      // proven above, so it cannot name a workspace this admin has no business in.
      workspaceCompanyId ? 'business'
      : tenantAccountType === 'business' ? 'business'
      : tenantAccountType === 'personal' ? 'personal'
      : reqAccountScope === 'business' ? 'business'
      : 'personal';

    /**
     * The companies to grant. The workspace's own company is always among them:
     * a member added inside Acme who could not open Acme is a member the admin
     * cannot see again — they would appear in no roster at all.
     */
    const grantCompanyIds = Array.from(new Set([
      ...(workspaceCompanyId ? [workspaceCompanyId] : []),
      ...(Array.isArray(reqCompanyIds) ? reqCompanyIds.filter((id: unknown) => typeof id === 'string') : []),
    ]));

    /**
     * ── THE SEAT LIMIT, ON THE AXIS THIS MEMBER IS JOINING ──────────────────
     *
     * `accountScope` and `grantCompanyIds` are both resolved ABOVE this — which
     * is not where they used to sit — because the limit depends on both:
     *
     *   personal  one allowance for the household  (`max_members`)
     *   business  one allowance PER COMPANY        (`max_members_per_company`)
     *
     * So a business member joining Acme and Beta is checked against each of
     * them, and a full Acme refuses the member even when Beta has room. A single
     * tenant-wide count would sell an allowance the plan does not offer.
     */
    const tenant = await db.query.tenants.findFirst({
      where: (t, { eq }) => eq(t.id, currentUser.tenantId)
    });

    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    // The plan for the axis being joined. A 'both' plan sits in BOTH columns, so
    // this resolves to the same row either way — which is the point of writing
    // it to both rather than making every reader consult `appliesTo`.
    const axisPlanId = accountScope === 'business'
      ? tenant.businessPlanId
      : tenant.subscriptionPlanId;
    const plan = axisPlanId
      ? await db.query.subscriptionPlans.findFirst({
          where: (p, { eq }) => eq(p.id, axisPlanId)
        })
      : null;

    /**
     * Add-on seats land on the axis they were bought for: "Additional user
     * (personal)" raises the household's allowance, "Additional user
     * (business)" raises the per-company one.
     *
     * The business branch adds nothing here because `companySeatCap` — which
     * the per-company check below calls — already includes it. Adding it twice
     * would sell one add-on as two seats.
     */
    const addonSeats = accountScope === 'business'
      ? 0
      : await activeAddonSeats(currentUser.tenantId, 'extraMembers');
    const totalAllowed = memberQuota(plan, tenant, accountScope) + addonSeats;

    /**
     * Live members only, through the shared `seatPredicate` — the SAME
     * definition /api/billing/summary reports with, so the screen and the form
     * cannot disagree about how full a workspace is.
     *
     * Two fixes carried over from the count this replaced, both of which were
     * refusing people it should not have: it counted BOTH accounts against
     * whichever plan was in hand, and it counted SOFT-DELETED rows, so removing
     * a member freed no seat despite memberRemoval.ts saying it does.
     */
    const seatsIn = (companyId: string | null) => withTenant(
      currentUser.tenantId,
      async (tx) => {
        const [row] = await tx
          .select({ n: count() })
          .from(users)
          .where(seatPredicate(currentUser.tenantId, accountScope, companyId));
        return row.n;
      },
    );

    if (accountScope === 'business') {
      // Every company being granted has to have room. Named in the message,
      // because "user limit reached" on a tenant with three companies does not
      // tell the admin which one to look at.
      const companyNames = new Map(
        (await withTenant(currentUser.tenantId, (tx) => tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(
            eq(companies.tenantId, currentUser.tenantId),
            inArray(companies.id, grantCompanyIds.length ? grantCompanyIds : ['']),
          ))))
          .map((c) => [c.id, c.name] as const),
      );

      for (const companyId of grantCompanyIds) {
        const used = await seatsIn(companyId);
        if (used >= totalAllowed) {
          const name = companyNames.get(companyId) || 'That company';
          return NextResponse.json({
            error: totalAllowed === 0
              // Zero means no business plan at all. "allows 0 members" reads as
              // a bug, and the fix is a plan rather than an add-on.
              ? 'Your plan does not include a business account. Upgrade to add employees.'
              : `${name} is full. Your plan allows ${totalAllowed} member(s) per company. `
                + 'Upgrade or buy an add-on to add more.',
          }, { status: 403 });
        }
      }
    } else if (await seatsIn(null) >= totalAllowed) {
      return NextResponse.json({
        error: `User limit reached. Your plan allows ${totalAllowed} member(s). `
          + 'Please purchase an add-on to add more.',
      }, { status: 403 });
    }

    // Check if email already exists — only when one was given. An unguarded
    // `eq(u.email, null)` would be a `= NULL` predicate: it matches nothing, so
    // this happened to be harmless, but the `email.toLowerCase()` above it was
    // a TypeError on every member added without an address.
    if (cleanEmail) {
      const existingUserByEmail = await db.query.users.findFirst({
        where: (u, { eq, and, isNull }) => and(isNull(u.deletedAt), eq(u.email, cleanEmail)),
      });

      if (existingUserByEmail) {
        return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
      }
    }


    const passwordHash = await hashPassword(password);

    const newUser = await withTenant(currentUser.tenantId, async (tx) => {
      // 1. Create the user
      const [user] = await tx.insert(users).values({
        tenantId: currentUser.tenantId,
        email: cleanEmail,
        passwordHash,
        name,
        // Optional for a member; an untouched PhoneInput ('+91') is stored as NULL.
        phoneNumber: isBlankPhone(phoneNumber) ? null : phoneNumber,
        // See src/db/schema.ts — the normalised form is what sign-in matches on,
        // and it is what lets this member log in with their mobile at all.
        phoneDial: toDialString(phoneNumber),
        // Which roster this member appears in, from here on. Set once and never
        // edited — see the column comment in src/db/schema.ts.
        accountScope,
        // emailVerified / phoneVerified are left at their default `false`.
        // A member is added as a record only: sign-in starts OFF, and nothing
        // is sent. When the admin gives access (POST /api/users/[id]/sign-in)
        // the member meets the first-login code challenge — WhatsApp, or email
        // when WhatsApp is off.
        signInDisabledAt: newRole === 'STANDARD' ? new Date() : null,
        role: newRole,
      }).returning();

      // 2. Create the default profile
      await tx.insert(profiles).values({
        userId: user.id,
        personalDetails: {
          dob: dob || null,
          anniversaryDate: anniversaryDate || null,
        },
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {},
      });

      // 3. Create the permissions if provided
      if (reqPermissions && Array.isArray(reqPermissions)) {
        await tx.insert(permissions).values(
          reqPermissions.map(p => ({
            userId: user.id,
            module: p.module,
            // See the same field in /api/users/[id]: NULL is the module default.
            documentKey: p.documentKey ?? null,
            canView: !!p.canView,
            canAdd: !!p.canAdd,
            canEdit: !!p.canEdit,
            canDelete: !!p.canDelete,
            canShare: !!p.canShare,
          }))
        );
      } else {
        // Defaults come from the registry, not a list maintained here. This was
        // a hardcoded TEN keys against the registry's twenty-one, so a user
        // created through the API rather than the UI silently had no access to
        // eleven modules — including every one added since the list was written.
        //
        // Seeded for ONE account. Handing over both halves is what let a member
        // added to work on a company also read the household's documents.
        await tx.insert(permissions).values(
          defaultPermissionsFor(accountScope).map((p) => ({ ...p, userId: user.id })),
        );
      }

      /**
       * A business member's company grants, in the same transaction as the user.
       *
       * The ids are re-resolved against THIS tenant rather than trusted from the
       * body: `company_access` carries no tenant column of its own, so a crafted
       * payload would otherwise grant a brand-new member access to a company in
       * somebody else's workspace.
       *
       * An admin needs no row (`hasCompanyAccess` short-circuits for them), so
       * this only ever runs for a STANDARD business member.
       */
      if (accountScope === 'business' && grantCompanyIds.length) {
        const valid = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(
            eq(companies.tenantId, currentUser.tenantId),
            isNull(companies.deletedAt),
            inArray(companies.id, grantCompanyIds),
          ));
        if (valid.length) {
          await tx.insert(companyAccess)
            .values(valid.map((c: any) => ({ userId: user.id, companyId: c.id })))
            .onConflictDoNothing();
        }
      }

      // 4. Log audit log
      await writeAudit({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        action: ACTIONS.user.create,
        details: auditSentence('create', {
          kind: 'member',
          name,
          note: `as a ${role || 'STANDARD'} user`,
        }),
        req,
        entityType: 'users',
        entityId: user?.id,
      }, tx);

      return user;
    });

    const { passwordHash: _, ...safeUser } = newUser;
    return NextResponse.json({ success: true, user: safeUser }, { status: 201 });
  } catch (error) {
    // Two members sharing a handset is a plausible thing for a tenant admin to
    // try; it should read as a form error, not as the platform falling over.
    if (isDuplicatePhone(error)) {
      return NextResponse.json({ error: DUPLICATE_PHONE_MESSAGE }, { status: 400 });
    }
    // The check above is not a guarantee — two admins adding the same address
    // at once both pass it and the index decides. Same 400 either way.
    if (isDuplicateEmail(error)) {
      return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
    }
    return serverError(error, 'creating user');
  }
}
