import { NextResponse } from 'next/server';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { users, profiles, permissions, companies, companyAccess } from '@/db/schema';
import { hashPassword } from '@/lib/auth';
import { getUserFromRequest } from '@/lib/auth';
import { validateUserContacts } from '@/lib/userContactValidation';
import { toDialString, isBlankPhone } from '@/lib/phone';
import {
  isDuplicatePhone, DUPLICATE_PHONE_MESSAGE,
  isDuplicateEmail, DUPLICATE_EMAIL_MESSAGE,
} from '@/lib/dbErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { defaultPermissionsFor } from '@/lib/moduleRegistry';
import { memberQuota } from '@/lib/billingAxis';
import { seatPredicate, activeAddonSeats } from '@/lib/account/seatCounts';
import { serverError } from '@/lib/routeError';

/**
 * Adds a member from the onboarding wizard.
 *
 * THE SECOND MEMBER-CREATION PATH, and it has to obey exactly the same rules as
 * POST /api/users — it did not. It required an email and never asked for a
 * phone number at all, so every member added through the wizard was written with
 * a null `phone_dial`: an account that cannot sign in, because the mobile number
 * IS the member login identity since 0039. They had no verification channel
 * either, which since 0040 means no way in at all.
 *
 * ── AND IT HAD NO DESTINATION ──────────────────────────────────────────────
 * The second gap, fixed here. This route wrote no `account_scope` and inserted
 * no `company_access` row, so:
 *
 *   both      every member the wizard created landed in the HOUSEHOLD, whatever
 *             the admin thought they were doing, and had to be re-created from
 *             /business/<id>/users afterwards.
 *   business  worse — business permissions were seeded but `account_scope` fell
 *             to its 'personal' default and no grant was written, so
 *             `workspaceMenu` offered them no household (the tenant has none)
 *             and no company (they hold no row). They could sign in and reach
 *             NOTHING.
 *
 * The scope resolution and the grant below are deliberately the same shape as
 * POST /api/users — see the long comments there. Two member-creation paths that
 * disagree about which half a person belongs to is the bug this whole file keeps
 * re-learning.
 */
export async function POST(req: Request) {
  try {
    const adminUser = await getUserFromRequest(req);

    if (!adminUser || adminUser.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const {
      name, email, password, phoneNumber,
      /** Which half of the account, on a tenant that has both. A hint only. */
      accountScope: reqAccountScope,
      /** The company this member works on. Re-resolved below, never trusted. */
      companyIds: reqCompanyIds,
      /**
       * Optional per-module overrides from the "Customize access now" step.
       * A starting point only — merged onto the server-resolved defaults
       * below by module name, never inserted as given. See that merge for why.
       */
      permissions: reqPermissions,
    } = await req.json();

    if (!name || !password) {
      return NextResponse.json({ success: false, error: 'Name and password are required' }, { status: 400 });
    }

    // Mobile mandatory, email optional — the wizard creates STANDARD members
    // only, and this is the single place that rule is spelled out.
    const contactCheck = validateUserContacts({ role: 'STANDARD', email, phoneNumber });
    if (!contactCheck.isValid) {
      const errorMsg = contactCheck.errors.phoneNumber || contactCheck.errors.email || 'Invalid contact details';
      return NextResponse.json({ success: false, error: errorMsg }, { status: 400 });
    }

    // No delivery preflight: like POST /api/users, the member is created with
    // sign-in OFF and nothing is sent until the admin gives them access.

    const cleanEmail = String(email || '').trim().toLowerCase() || null;

    // Only when one was given — a member legitimately may have no address.
    if (cleanEmail) {
      const existingUser = await db.query.users.findFirst({
        where: (users, { eq, and, isNull }) => and(isNull(users.deletedAt), eq(users.email, cleanEmail)),
      });

      if (existingUser) {
        return NextResponse.json({ success: false, error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
      }
    }

    /**
     * ── WHICH HALF OF THE ACCOUNT THIS MEMBER IS BEING ADDED TO ─────────────
     *
     * Resolved from the TENANT, with the body as a tie-break and nothing more —
     * the same order POST /api/users resolves it in. A `personal` tenant has no
     * business side and a `business` one has no household, so a request naming
     * the other half is corrected rather than refused: there is no meaningful
     * thing it could have been asking for.
     *
     * Only `both` genuinely has a choice, and it falls to 'personal' — the
     * value every workspace had before the business account existed, and the
     * safe direction to be wrong in. `account_scope` cannot be edited after
     * creation (src/db/schema.ts), so a wrong 'business' is a member the admin
     * must delete and re-create; a wrong 'personal' is a grant they can add.
     */
    const tenantAccountType = (adminUser as any).tenant?.accountType ?? 'personal';
    const accountScope: 'personal' | 'business' =
      tenantAccountType === 'business' ? 'business'
      : tenantAccountType === 'personal' ? 'personal'
      : reqAccountScope === 'business' ? 'business'
      : 'personal';

    /**
     * The companies to grant, RE-RESOLVED against this tenant.
     *
     * `company_access` carries no tenant column of its own — its RLS policy
     * reaches the tenant through `user_id -> users` — so an id straight off the
     * body would file a brand-new member under somebody else's company. This
     * select is the only thing standing in the way, which is why it re-asserts
     * `tenantId` rather than relying on `withTenant` alone.
     */
    const wantedCompanyIds = accountScope === 'business' && Array.isArray(reqCompanyIds)
      ? Array.from(new Set(reqCompanyIds.filter((id: unknown): id is string => typeof id === 'string' && id !== '')))
      : [];

    const grantCompanies = wantedCompanyIds.length
      ? await withTenant(adminUser.tenantId, (tx) => tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(
            eq(companies.tenantId, adminUser.tenantId),
            isNull(companies.deletedAt),
            inArray(companies.id, wantedCompanyIds),
          )))
      : [];

    /**
     * A business member with no company is the one state this route must not be
     * able to create — it is exactly the dead end described at the top of this
     * file. They would appear in no roster, so no admin could find them again,
     * and the workspace switcher would offer them nowhere to go.
     */
    if (accountScope === 'business' && grantCompanies.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Choose which company this member works on. Add the company first if it does not exist yet.',
      }, { status: 400 });
    }

    /**
     * ── THE SEAT LIMIT, ON THE AXIS BEING JOINED ────────────────────────────
     *
     * This route had NO seat check at all, which made the wizard a way around
     * the plan every other member-creation path enforces. Same allowances and
     * the same counting as POST /api/users, through the shared `seatPredicate`:
     *
     *   personal  one allowance for the household   (`max_members`)
     *   business  one allowance PER COMPANY         (`max_members_per_company`)
     *
     * The business branch adds no add-on seats of its own because `memberQuota`
     * on that axis already reads `extra_members_per_company` off the tenant;
     * adding `activeAddonSeats` there too would sell one add-on twice.
     */
    const tenant = await db.query.tenants.findFirst({
      where: (t, { eq }) => eq(t.id, adminUser.tenantId),
    });
    if (!tenant) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }

    // A 'both' plan is written to BOTH columns, so this resolves to the same row
    // either way — the point of writing it twice rather than reading `applies_to`.
    const axisPlanId = accountScope === 'business' ? tenant.businessPlanId : tenant.subscriptionPlanId;
    const plan = axisPlanId
      ? await db.query.subscriptionPlans.findFirst({ where: (p, { eq }) => eq(p.id, axisPlanId) })
      : null;

    const totalAllowed = memberQuota(plan, tenant, accountScope)
      + (accountScope === 'business' ? 0 : await activeAddonSeats(adminUser.tenantId, 'extraMembers'));

    const seatsIn = (companyId: string | null) => withTenant(
      adminUser.tenantId,
      async (tx) => {
        const [row] = await tx
          .select({ n: count() })
          .from(users)
          .where(seatPredicate(adminUser.tenantId, accountScope, companyId));
        return row.n;
      },
    );

    if (accountScope === 'business') {
      // Named in the message: "member limit reached" on an account with three
      // companies does not tell the admin which one to look at.
      for (const company of grantCompanies) {
        if (await seatsIn(company.id) >= totalAllowed) {
          return NextResponse.json({
            success: false,
            error: totalAllowed === 0
              ? 'Your plan does not include a business account. Upgrade to add employees.'
              : `${company.name} is full. Your plan allows ${totalAllowed} member(s) per company. `
                + 'Upgrade or buy an add-on to add more.',
          }, { status: 403 });
        }
      }
    } else if (await seatsIn(null) >= totalAllowed) {
      return NextResponse.json({
        success: false,
        error: `Member limit reached. Your plan allows ${totalAllowed} member(s). `
          + 'Please purchase an add-on to add more.',
      }, { status: 403 });
    }

    const passwordHash = await hashPassword(password);

    // Create User, Profile, and AuditLog inside a transaction
    await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        tenantId: adminUser.tenantId,
        email: cleanEmail,
        passwordHash,
        name,
        // Optional for a member; an untouched PhoneInput ('+91') is stored as NULL.
        phoneNumber: isBlankPhone(phoneNumber) ? null : phoneNumber,
        // In the same statement as phoneNumber, always — see src/db/schema.ts.
        // This is the column sign-in matches on, and its absence is why members
        // added through this wizard could not log in at all.
        phoneDial: toDialString(phoneNumber),
        role: 'STANDARD',
        // Which half of the account they belong to. Written here rather than
        // left to the column default, which is what filed every wizard-created
        // business member under a household they had no permissions for.
        accountScope,
        requiresPasswordChange: true, // Force password change on first login
        // Added as a record only — see POST /api/users. Access is given later.
        signInDisabledAt: new Date(),
      }).returning();

      // Create default empty profile
      await tx.insert(profiles).values({
        userId: user.id,
        personalDetails: {},
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {},
      });

      // Seed permissions. Without this a member added through the onboarding
      // wizard got ZERO permission rows, and `hasPermission` denies on a
      // missing row — so they could sign in and see nothing at all, with no
      // error to explain why. Members added later through /users got the
      // defaults, which is why the gap went unnoticed.
      //
      // Seeded for ONE account — the one resolved above, not guessed from the
      // tenant's shape. That guess read `accountType === 'business'`, so a
      // `both` tenant seeded PERSONAL modules for a member the admin had just
      // added to a company: every business module then denied on a missing row.
      //
      // `reqPermissions` (from the "Customize access now" step) is layered on
      // TOP of that default set by module name — never inserted on its own.
      // That keeps the guarantee above intact (every module always gets a
      // row, whatever the client sent) and means a client payload can only
      // override a module this scope already grants by default, never name
      // one of its own.
      const permissionDefaults = defaultPermissionsFor(accountScope);
      const permissionOverrides = new Map(
        (Array.isArray(reqPermissions) ? reqPermissions : [])
          .filter((p: any) => p && typeof p.module === 'string')
          .map((p: any) => [p.module, p]),
      );
      const finalPermissions = permissionDefaults.map((d) => {
        const o = permissionOverrides.get(d.module);
        return o
          ? { module: d.module, documentKey: null, canView: !!o.canView, canAdd: !!o.canAdd, canEdit: !!o.canEdit, canDelete: !!o.canDelete, canShare: !!o.canShare }
          : d;
      });
      await tx.insert(permissions).values(
        finalPermissions.map((p) => ({ ...p, userId: user.id })),
      );

      /**
       * The company grant, in the same transaction as the member.
       *
       * Ids come from `grantCompanies`, which was re-resolved against this
       * tenant above — never from the body. An admin needs no row of their own
       * (`hasCompanyAccess` short-circuits for them), so this only ever runs for
       * the STANDARD members this route creates.
       */
      if (accountScope === 'business' && grantCompanies.length) {
        await tx.insert(companyAccess)
          .values(grantCompanies.map((c) => ({ userId: user.id, companyId: c.id })))
          .onConflictDoNothing();
      }

      // Create audit log
      await writeAudit({
        tenantId: adminUser.tenantId,
        userId: adminUser.id,
        action: ACTIONS.user.onboarding_create,
        // The number is the member's identity now, so it is what the note
        // names — the address may be null. WHERE they were filed is named too:
        // `account_scope` cannot be edited afterwards, so the log is the only
        // record of a choice that has to be undone by deleting the member.
        details: auditSentence('onboarding_create', {
          kind: 'member',
          name: user.name,
          note: [
            'during onboarding',
            grantCompanies.length ? `onto ${grantCompanies.map((c) => c.name).join(', ')}` : 'onto the household',
            user.phoneNumber ? `on ${user.phoneNumber}` : null,
          ].filter(Boolean).join(', '),
        }),
        req,
        entityType: 'users',
        entityId: user?.id,
      }, tx);
    });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    // Both are plausible things to hit by hand — one handset shared by two
    // relatives, or an address already used elsewhere — and should read as form
    // errors, not as the platform falling over.
    if (isDuplicatePhone(error)) {
      return NextResponse.json({ success: false, error: DUPLICATE_PHONE_MESSAGE }, { status: 400 });
    }
    if (isDuplicateEmail(error)) {
      return NextResponse.json({ success: false, error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
    }
    return serverError(error, 'adding this member');
  }
}
