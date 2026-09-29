import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, withTenant } from '@/lib/db';
import { users, profiles, permissions, companies } from '@/db/schema';
import { eq, and, count, inArray, isNull } from 'drizzle-orm';
import { getUserFromRequest, hashPassword } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { toDialString } from '@/lib/phone';
import { validateUserContacts } from '@/lib/userContactValidation';
import {
  isDuplicatePhone, DUPLICATE_PHONE_MESSAGE,
  isDuplicateEmail, DUPLICATE_EMAIL_MESSAGE,
} from '@/lib/dbErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { workspaceMemberScope } from '@/lib/account/workspaceMemberScope';
import { companyAccess } from '@/db/schema';
import { companySeatCap, seatPredicate } from '@/lib/account/seatCounts';
import {
  deleteSelectedHolderRecords,
  finishMemberRecordPurge,
  revokeMemberAccess,
} from '@/lib/account/memberRemoval';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const currentUser = await getUserFromRequest(req);
    if (!currentUser || (currentUser.role !== 'TENANT_ADMIN' && currentUser.role !== 'SUPER_ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;

    const user = await withTenant(currentUser.tenantId, async (tx) => {
      return await tx.query.users.findFirst({
        where: (users, { eq, and, isNull }) => and(
          eq(users.id, id),
          eq(users.tenantId, currentUser.tenantId),
          // A removed member is retained so their records keep a holder, but
          // they are not a user any more — see memberRemoval.ts.
          isNull(users.deletedAt),
        ),
        with: {
          permissions: true,
          profile: true,
        },
      });
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.role === 'SUPER_ADMIN' && currentUser.role === 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { passwordHash, ...safeUser } = user;
    return NextResponse.json({ success: true, user: safeUser });
  } catch (error) {
    return serverError(error, 'loading user details');
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const currentUser = await getUserFromRequest(req);
    if (!currentUser || (currentUser.role !== 'TENANT_ADMIN' && currentUser.role !== 'SUPER_ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;

    const targetUser = await withTenant(currentUser.tenantId, async (tx) => {
      return await tx.query.users.findFirst({
        where: (users, { eq, and, isNull }) => and(
          eq(users.id, id),
          eq(users.tenantId, currentUser.tenantId),
          isNull(users.deletedAt),
        ),
      });
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const workspace = await workspaceMemberScope(req, currentUser, targetUser as any);
    if ('error' in workspace) return workspace.error;

    if (targetUser.role === 'SUPER_ADMIN' && currentUser.role === 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const {
      name, email, password, phoneNumber, role, permissions: reqPermissions, dob, anniversaryDate,
      /**
       * The companies this member works on, replacing whatever they hold.
       *
       * Absent means untouched — this is a PATCH-shaped body and the details
       * dialog sends no companies at all. See `grantCompanyIds` below for what
       * an admin is actually allowed to express here.
       */
      companyIds: reqCompanyIds,
    } = await req.json();

    // ── VALIDATE THE CONTACTS THIS EDIT WOULD LEAVE BEHIND ─────────────────
    // A PATCH-shaped body, so each field is only being changed if it was sent.
    // The check has to run against the MERGED result rather than the payload:
    // an edit that omits `phoneNumber` entirely is fine, but one that sends an
    // empty string is an admin blanking a member's mobile — which silently
    // revokes their ability to sign in at all, since the number IS their login
    // identity. Nothing stopped that before; POST validated and PUT did not.
    const effectiveRole = (role && currentUser.role === 'TENANT_ADMIN' ? role : targetUser.role) as any;
    // Optional for a member, so '' is a deliberate clear, not a missing field.
    const cleanEmail = email !== undefined ? (String(email || '').trim().toLowerCase() || null) : undefined;

    const contactCheck = validateUserContacts({
      role: effectiveRole,
      email: cleanEmail !== undefined ? cleanEmail : targetUser.email,
      phoneNumber: phoneNumber !== undefined ? phoneNumber : targetUser.phoneNumber,
    });
    if (!contactCheck.isValid) {
      const errorMsg = contactCheck.errors.phoneNumber || contactCheck.errors.email || 'Invalid contact details';
      return NextResponse.json({ error: errorMsg }, { status: 400 });
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (phoneNumber !== undefined) {
      updateData.phoneNumber = phoneNumber;
      // Always in the same breath as phoneNumber. Updating one without the
      // other would leave this member signing in with their OLD number.
      updateData.phoneDial = toDialString(phoneNumber);
    }
    if (role && currentUser.role === 'TENANT_ADMIN') updateData.role = role; // only tenant admin can change role

    if (cleanEmail !== undefined && cleanEmail !== targetUser.email) {
      // `cleanEmail === null` is a member's address being REMOVED — allowed
      // since 0040, and there is nothing to check for a collision against.
      if (cleanEmail) {
        const existing = await db.query.users.findFirst({
          where: (users, { eq, and, isNull }) => and(isNull(users.deletedAt), eq(users.email, cleanEmail)),
        });
        if (existing) {
          return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
        }
      }
      updateData.email = cleanEmail;
    }

    if (password) {
      updateData.passwordHash = await hashPassword(password);
    }

    /**
     * ── THE COMPANIES THIS MEMBER WORKS ON ──────────────────────────────────
     *
     * The rare case: one person working on two of this account's companies.
     * It used to live in a per-company checklist that listed the whole tenant;
     * this is the same grant at the grain it belongs to, the member.
     *
     * Only for a STANDARD member of the business account, and only from inside
     * a company. An admin holds no rows at all (`hasCompanyAccess`
     * short-circuits for them) and a personal member has no company to reach,
     * so for both of those the field is ignored rather than refused — the
     * caller cannot express anything meaningful there.
     *
     * ── THE WORKSPACE IS ALWAYS IN THE SET ──────────────────────────────────
     * Forced in, exactly as POST /api/users forces it. A business member
     * holding NO grant appears in no roster and can never be edited or removed
     * again — `workspaceMemberScope` above would 404 every later request about
     * them. That is the one state this route must not be able to create, so the
     * empty set is a 400 rather than a write.
     *
     * ── IDS ARE RE-RESOLVED, NEVER TRUSTED ──────────────────────────────────
     * `company_access` carries no tenant column of its own, so a crafted body
     * would otherwise grant this member a company in somebody else's workspace.
     * The select is the same one POST issues.
     */
    const editsCompanies = Array.isArray(reqCompanyIds)
      && !!workspace.companyId
      && targetUser.accountScope === 'business'
      && targetUser.role === 'STANDARD';

    let grantCompanyIds: string[] = [];
    if (editsCompanies) {
      const asked = Array.from(new Set<string>([
        workspace.companyId!,
        ...reqCompanyIds.filter((c: unknown): c is string => typeof c === 'string'),
      ]));
      const valid = await withTenant(currentUser.tenantId, (tx) => tx
        // `name` as well as `id`: the over-quota message names the full company,
        // because "user limit reached" on a tenant with three of them says
        // nothing about which one to look at.
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(and(
          eq(companies.tenantId, currentUser.tenantId),
          isNull(companies.deletedAt),
          inArray(companies.id, asked),
        )));
      grantCompanyIds = valid.map((c: any) => c.id);
      if (grantCompanyIds.length === 0) {
        return NextResponse.json({
          error: 'A member has to work on at least one company.',
        }, { status: 400 });
      }

      /**
       * ── THE PER-COMPANY SEAT LIMIT, ON THE COMPANIES BEING ADDED ─────────
       *
       * A business plan sells a member allowance PER COMPANY, and this handler
       * can move a member onto a company they were not on — so a full company
       * has to refuse them here exactly as it would at creation, or the limit is
       * one edit away from being meaningless.
       *
       * Only companies being ADDED are checked. The member already occupies a
       * seat on the ones they hold, so re-submitting an unchanged set must not
       * start failing the moment a plan is downgraded — that would strand an
       * admin unable to edit anyone's details until they bought more seats.
       */
      const held = new Set((await withTenant(currentUser.tenantId, (tx) => tx
        .select({ companyId: companyAccess.companyId })
        .from(companyAccess)
        .where(eq(companyAccess.userId, id))))
        .map((row) => row.companyId));

      const added = grantCompanyIds.filter((companyId) => !held.has(companyId));
      if (added.length > 0) {
        const seatCap = await companySeatCap(currentUser.tenantId);
        for (const companyId of added) {
          const [row] = await withTenant(currentUser.tenantId, (tx) => tx
            .select({ n: count() })
            .from(users)
            .where(seatPredicate(currentUser.tenantId, 'business', companyId)));
          if (row.n >= seatCap) {
            const name = valid.find((c: any) => c.id === companyId)?.name;
            return NextResponse.json({
              error: `${name || 'That company'} is full. Your plan allows ${seatCap} `
                + 'member(s) per company. Upgrade or buy an add-on to add more.',
            }, { status: 403 });
          }
        }
      }
    }

    const updatedUser = await withTenant(currentUser.tenantId, async (tx) => {
      // Update basic details
      let user = targetUser;
      if (Object.keys(updateData).length > 0) {
        const [updated] = await tx.update(users)
          .set(updateData)
          .where(eq(users.id, id))
          .returning();
        user = updated;
      }

      // Update profile dob/anniversaryDate if passed
      if (dob !== undefined || anniversaryDate !== undefined) {
        const existingProfile = await tx.query.profiles.findFirst({
          where: (profiles, { eq }) => eq(profiles.userId, id)
        });
        
        const currentPersonal = (existingProfile?.personalDetails as object || {});
        const newPersonalDetails = {
          ...currentPersonal,
          ...(dob !== undefined ? { dob } : {}),
          ...(anniversaryDate !== undefined ? { anniversaryDate } : {}),
        };

        if (existingProfile) {
          await tx.update(profiles)
            .set({ personalDetails: newPersonalDetails })
            .where(eq(profiles.userId, id));
        } else {
          await tx.insert(profiles).values({
            userId: id,
            personalDetails: newPersonalDetails,
            educationDetails: {},
            shoppingDetails: {},
            legalDetails: {},
          });
        }
      }

      // Update permissions if provided
      if (reqPermissions && Array.isArray(reqPermissions)) {
        // Delete old permissions
        await tx.delete(permissions).where(eq(permissions.userId, id));

        // Insert new permissions
        if (reqPermissions.length > 0) {
          await tx.insert(permissions).values(
            reqPermissions.map(p => ({
              userId: id,
              module: p.module,
              // NULL = the module default; a string = an override for that one
              // sub-category. Sent as null by the UI for every module row, so a
              // client that predates 0024 still writes valid defaults.
              documentKey: p.documentKey ?? null,
              canView: !!p.canView,
              canAdd: !!p.canAdd,
              canEdit: !!p.canEdit,
              canDelete: !!p.canDelete,
              canShare: !!p.canShare,
            }))
          );
        }
      }

      /**
       * Replace, not diff — the screen submits the set it is showing, and
       * applying that as a diff means two admins editing at once merge into a
       * third intention neither of them chose. Same reasoning as the
       * permissions replace above it.
       */
      if (editsCompanies) {
        await tx.delete(companyAccess).where(eq(companyAccess.userId, id));
        await tx.insert(companyAccess)
          .values(grantCompanyIds.map((companyId) => ({ userId: id, companyId })))
          .onConflictDoNothing();
      }

      // Log action
      await writeAudit({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        action: ACTIONS.user.update,
        details: auditSentence('update', {
          kind: 'member',
          name: targetUser.name,
          note: editsCompanies
            ? `details, permissions and the ${grantCompanyIds.length} compan${grantCompanyIds.length === 1 ? 'y' : 'ies'} they work on`
            : 'details and permissions',
        }),
        req,
        entityType: 'users',
        entityId: id,
      }, tx);

      return user;
    });

    const { passwordHash: _, ...safeUser } = updatedUser;
    return NextResponse.json({ success: true, user: safeUser });
  } catch (error) {
    if (isDuplicatePhone(error)) {
      return NextResponse.json({ error: DUPLICATE_PHONE_MESSAGE }, { status: 400 });
    }
    if (isDuplicateEmail(error)) {
      return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
    }
    return serverError(error, 'updating user details');
  }
}

/**
 * What the admin chose in the removal dialog.
 *
 * `mode` is REQUIRED rather than defaulted. One path destroys records and the
 * other does not, and a client that predates this dialog must not be able to
 * fall through to either by omission — so a missing or malformed body is a 400,
 * never an assumed intent.
 *
 * The 500-id ceiling is the one /api/documents/bulk-delete already uses, for the
 * same reason: it bounds the transaction and the audit rows a single request can
 * produce.
 */
const removalSchema = z.object({
  mode: z.enum(['retain', 'delete']),
  documentIds: z.array(z.string().uuid()).max(500).optional(),
  passwordIds: z.array(z.string().uuid()).max(500).optional(),
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   REMOVE A MEMBER — access always, their records only if asked    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This used to be `tx.delete(users)`, and every `ON DELETE CASCADE` pointing at
 * `users.id` fired behind it: the member's documents, their password vault,
 * their wrapped vault key, their devices — and their whole `audit_logs` history.
 * None of it went through the deletion pipeline the rest of the product uses, so
 * the ciphertext stayed on the tenant's Drive, orphaned, while every row that
 * referenced it disappeared.
 *
 * It is now two separable things:
 *
 *   ACCESS  — revoked unconditionally, on both paths. The row is RETAINED with
 *             `deleted_at` stamped, so `holder_id` keeps resolving and the audit
 *             trail survives; credentials, permissions, vault keys and devices
 *             are destroyed outright (`revokeMemberAccess`).
 *   RECORDS — only the ones the admin ticked in the picker, tombstoned through
 *             the same shared pipeline every other delete path uses, and taken
 *             off Drive once the transaction has committed.
 *
 * See src/lib/account/memberRemoval.ts for both halves, and for why the ids
 * arriving in the body are safe to accept.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const currentUser = await getUserFromRequest(req);
    if (!currentUser || (currentUser.role !== 'TENANT_ADMIN' && currentUser.role !== 'SUPER_ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;

    const targetUser = await withTenant(currentUser.tenantId, async (tx) => {
      return await tx.query.users.findFirst({
        where: (users, { eq, and, isNull }) => and(
          eq(users.id, id),
          eq(users.tenantId, currentUser.tenantId),
          // Makes a double-submit a clean 404 rather than a second revocation
          // that would re-stamp `deleted_at` and tombstone the email twice.
          isNull(users.deletedAt),
        ),
      });
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const workspace = await workspaceMemberScope(req, currentUser, targetUser as any);
    if ('error' in workspace) return workspace.error;

    if (targetUser.role === 'SUPER_ADMIN' && currentUser.role === 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (targetUser.id === currentUser.id) {
      return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const parsed = removalSchema.safeParse(body);

    /**
     * Only a STANDARD member can be a record HOLDER, so only their removal has
     * a choice to make. An admin has nothing filed under them — which is why the
     * body is not required for one, and why it is ignored rather than honoured
     * if sent: a 'delete' aimed at an admin would ask to delete records that by
     * definition do not exist.
     */
    const isHolder = targetUser.role === 'STANDARD';
    if (isHolder && !parsed.success) {
      return NextResponse.json(
        { error: "Choose whether to keep or delete this member's records before removing them." },
        { status: 400 },
      );
    }
    const mode = isHolder && parsed.success ? parsed.data.mode : 'retain';
    const selection = {
      documentIds: (parsed.success && parsed.data.documentIds) || [],
      passwordIds: (parsed.success && parsed.data.passwordIds) || [],
    };

    const outcome = await withTenant(currentUser.tenantId, async (tx) => {
      await revokeMemberAccess(tx, currentUser, targetUser);

      const removed = mode === 'delete'
        ? await deleteSelectedHolderRecords(
          tx, currentUser, { id: targetUser.id, name: targetUser.name }, selection, req,
        )
        : { counts: { documents: 0, passwords: 0 }, doomed: [] };

      await writeAudit({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        action: ACTIONS.user.delete,
        details: auditSentence('delete', {
          kind: 'member',
          name: targetUser.name,
          note: mode === 'delete'
            ? `${removed.counts.documents} record(s) and ${removed.counts.passwords} password(s) `
              + 'filed under them were deleted too'
            : 'their records were kept',
        }),
        req,
        entityType: 'users',
        entityId: id,
      }, tx);

      return removed;
    });

    // Drive is a remote service, so it is dealt with after the tombstones have
    // committed — a purge failure costs an orphan, not a wrong answer.
    await finishMemberRecordPurge(currentUser, outcome.doomed);

    return NextResponse.json({
      success: true,
      message: 'Member removed successfully',
      deleted: outcome.counts,
    });
  } catch (error) {
    return serverError(error, 'deleting user');
  }
}
