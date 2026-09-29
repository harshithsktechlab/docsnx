import { NextRequest, NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { passwords } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import {
  accountScopeFor, inCompanyOf, resolveUtilityCompany,
} from '@/lib/records/companyScope';
import { encrypt, decrypt } from '@/lib/encryption';
import { autoUpdateProfile } from '@/lib/profileUpdater';
import { eq, and, asc, count, isNull } from 'drizzle-orm';
import { parseQueryParams, buildListQueryHelper } from '@/lib/api-pagination';
import { z } from 'zod';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { randomUUID } from 'crypto';
import { requireDriveConnected } from '@/lib/vault/vaultMode';
import { resolveHolder, assertHolderInTenant, holderErrorResponse } from '@/lib/records/handler';
import { isWorkspaceMember } from '@/lib/records/workspaceMembers';
import { storePasswordInVault } from '@/lib/vault/vaultPasswords';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { serverError } from '@/lib/routeError';

const passwordSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  category: z.string().max(100).optional().nullable(),
  url: z.string().max(1000).optional().nullable(),
  username: z.string().min(1, 'Username is required').max(255),
  password: z.string().min(1, 'Password is required'),
  notes: z.string().optional().nullable(),
  customFields: z.array(z.any()).optional().nullable(),
  userId: z.string().uuid().optional().nullable(),
  /**
   * "Belongs to" — the member this credential is ABOUT. A uuid, or one
   * of the sentinels ('', 'all', 'none') meaning all members. Not
   * `.uuid()`, because the sentinels have to survive validation for
   * `resolveHolder` to read them; the uuid case is checked against the tenant
   * by `assertHolderInTenant` below.
   */
  holderId: z.string().max(64).optional().nullable(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'passwords', 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account's credentials this list is. Proven, not taken: an id in the
    // query string is untrusted, and `resolveUtilityCompany` is what puts it
    // through `hasCompanyAccess` before it reaches a predicate.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const params = parseQueryParams(req);
    const targetUserId = params.filters.userId;
    const category = params.filters.category;

    const { limit, offset, orderBy, searchFilter } = buildListQueryHelper(passwords, params, [
      passwords.title,
      passwords.username,
      passwords.url,
      passwords.category
    ]);

    let finalUserId: string | undefined;

    if (targetUserId) {
      finalUserId = targetUserId;
    }

    const conditions = [
      eq(passwords.tenantId, user.tenantId),
      /**
       * WHICH account's credential list.
       *
       * One handler serves both: `/passwords` is the household's and
       * `/business/<id>/passwords` is that company's, and this single predicate
       * is the whole of the difference between them. There is no RLS behind it
       * — both rows carry the same `tenant_id` — so dropping it does not fail,
       * it lists the other account's credentials successfully.
       */
      inCompanyOf(passwords.companyId, scope.companyId),
      isNull(passwords.deletedAt)
    ];
    if (finalUserId) {
      conditions.push(eq(passwords.userId, finalUserId));
    }
    if (category) {
      conditions.push(eq(passwords.category, category));
    }
    if (searchFilter) {
      conditions.push(searchFilter);
    }

    const whereClause = and(...conditions);

    const result = await withTenant(user.tenantId, async (tx) => {
      const [total] = await tx.select({ count: count() }).from(passwords).where(whereClause);
      
      const passwordsList = await tx.query.passwords.findMany({
        where: whereClause,
        with: {
          user: {
            columns: { name: true }
          },
          holder: {
            columns: { id: true, name: true }
          }
        },
        orderBy: orderBy,
        limit,
        offset
      });
      return { totalCount: total.count, passwordsList };
    });

    const totalCount = result.totalCount;
    const totalPages = Math.ceil(totalCount / limit);
    const passwordsList = result.passwordsList;

    // Do not decrypt passwords in the list view for security.
    // They should be fetched individually or decrypted client-side.
    const safePasswordsList = passwordsList.map(p => {
      const { passwordEncrypted, ...safeRecord } = p;
      return safeRecord;
    });

    return NextResponse.json({ 
      success: true, 
      passwords: safePasswordsList,
      pagination: {
        page: params.page,
        limit,
        totalCount,
        totalPages
      }
    });
  } catch (error) {
    return serverError(error, 'listing passwords');
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'passwords', 'add');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this credential is being filed into. Proven before it is
    // used as a column value or as a vault scope.
    const writeScope = await resolveUtilityCompany(req, user);
    if ('error' in writeScope) return writeScope.error;

    const body = await req.json();
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.format() }, { status: 400 });
    }

    const { title, category, url, username, password, notes, customFields, userId } = parsed.data;

    // One control, two columns: "All members" clears the holder and sets
    // is_global, a member sets the holder and clears it. Same rules as every
    // other module — see resolveHolder in src/lib/records/handler.ts.
    const { holderId, isGlobal } = resolveHolder({ holderId: parsed.data.holderId });
    // The check already reads the holder row; its name is what the audit line
    // needs to say whose credential this is.
    const holderName = holderId ? await assertHolderInTenant(user, holderId) : null;
    // And a member of the workspace this credential is filed in — a company
    // password never under a household member, nor a household one under a
    // business-only employee. See src/lib/records/workspaceMembers.ts.
    if (holderId && !await isWorkspaceMember(user.tenantId, holderId, writeScope.companyId)) {
      return NextResponse.json({ error: 'That member is not part of this workspace' }, { status: 400 });
    }

    if (userId && userId !== user.id && user.role !== 'TENANT_ADMIN' && user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only administrators can create records for other users' }, { status: 403 });
    }

    const targetUserId = userId || user.id;

    // Google Drive is mandatory — the secret is stored there, so without a
    // grant there is nowhere to put it.
    const blocked = requireDriveConnected(user.tenant);
    if (blocked) return blocked;

    const recordId = randomUUID();

    // The secret goes to the tenant's Drive store, sealed with the tenant key.
    // Deliberately BEFORE the row is written: if Drive fails there is no row
    // claiming to hold a credential whose value does not exist anywhere.
    const vault = await storePasswordInVault({
      tenant: user.tenant,
      tenantId: user.tenantId,
      // Selects the Drive folder tree and the AAD the secret is sealed under.
      companyId: writeScope.companyId,
      actorUserId: user.id,
      ownerId: targetUserId,
      holderId,
      isGlobal,
      recordId,
      category,
      title,
      username,
      url,
      password,
      notes,
      customFields: customFields || [],
    });

    const { credential } = await withTenant(user.tenantId, async (tx) => {
      const [cred] = await tx.insert(passwords).values({
        id: recordId,
        tenantId: user.tenantId,
        userId: targetUserId,
        holderId,
        // The account axis, and its stored mirror. Derived from the proven
        // scope rather than accepted from the body, so the CHECK constraint
        // keeping the pair in step can never be the thing that catches a bug.
        companyId: writeScope.companyId,
        accountScope: accountScopeFor(writeScope.companyId),
        isGlobal,
        title,
        category: category || 'other',
        url,
        username,
        // passwordEncrypted is deliberately NOT written: the secret lives only
        // in the Drive store now. Postgres keeps the searchable identifiers.
        notes,
        customFields: customFields || [],
        categoryModuleKey: vault.categoryModuleKey,
        categoryDocumentKey: vault.categoryDocumentKey,
        jsonDriveId: vault.jsonDriveId,
        keyVersion: vault.keyVersion,
        status: vault.status,
      }).returning();

      // Log action
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this row was created in, already proven by
        // `resolveUtilityCompany`. Files the event in that workspace's tab.
        companyId: writeScope.companyId,
        action: ACTIONS.password.create,
        details: auditSentence('create', { kind: 'password', name: title, member: holderName }),
        req,
        entityType: 'passwords',
        entityId: cred?.id,
      }, tx);

      return { credential: cred };
    });

    // Auto-update profile
    await autoUpdateProfile(targetUserId, 'passwords', credential);

    return NextResponse.json({ success: true, password: { ...credential, password } }, { status: 201 });
  } catch (error) {
    const holder = holderErrorResponse(error);
    if (holder) return holder;
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    return serverError(error, 'creating password');
  }
}
