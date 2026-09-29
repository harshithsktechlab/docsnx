import { NextRequest, NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { passwords } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { decrypt } from '@/lib/encryption';
import { autoUpdateProfile } from '@/lib/profileUpdater';
import { eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { deletePasswordInVault, revealPassword, storePasswordInVault } from '@/lib/vault/vaultPasswords';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { requireDriveConnected } from '@/lib/vault/vaultMode';
import { resolveHolder, assertHolderInTenant, holderErrorResponse } from '@/lib/records/handler';
import { isWorkspaceMember } from '@/lib/records/workspaceMembers';
import { serverError } from '@/lib/routeError';

const passwordUpdateSchema = z.object({
  bankName: z.string().optional(),
  title: z.string().min(1).max(255).optional(),
  category: z.string().max(100).optional().nullable(),
  url: z.string().max(1000).optional().nullable(),
  username: z.string().min(1).max(255).optional(),
  password: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
  customFields: z.array(z.any()).optional().nullable(),
  /** "Belongs to". Same sentinels as the create route — see /api/passwords. */
  holderId: z.string().max(64).optional().nullable(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'passwords', 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value then scopes every
    // statement below, read and write alike — a predicate that guards only the
    // lookup guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const record = await withTenant(user.tenantId, async (tx) => {
      return await tx.query.passwords.findFirst({
        where: and(
        eq(passwords.id, id),
        eq(passwords.tenantId, user.tenantId),
        // The record's own account. Restated on every statement, including
        // the writes — a predicate that guards only the lookup guards nothing.
        inCompanyOf(passwords.companyId, scope.companyId),
        isNull(passwords.deletedAt),
      ),
        // The member this credential is filed under, for the audit line. Name
        // only: the users row carries reset tokens and OTPs.
        with: { holder: { columns: { name: true } } },
      });
    });

    if (!record) {
      return NextResponse.json({ error: 'Password credential not found' }, { status: 404 });
    }

    

    // The secret lives in the tenant's Drive store now. Legacy rows still hold
    // password_encrypted, so fall back to that rather than breaking them.
    let secret: string | null = null;
    let notes: string | null = record.notes ?? null;

    if (record.categoryModuleKey && record.categoryDocumentKey) {
      const revealed = await revealPassword(
        {
          tenant: user.tenant,
          tenantId: user.tenantId,
          // Read off the request scope that already matched this row, so the
          // reveal opens the store the record was WRITTEN to. Omitted, this
          // resolved to the personal pointer for every company credential:
          // the record was simply not in that file, so the route answered
          // `password: null` with `success: true` and the eye showed nothing.
          companyId: scope.companyId,
          userId: user.id,
        },
        { moduleKey: record.categoryModuleKey, documentKey: record.categoryDocumentKey },
        record.id
      );
      secret = revealed?.password ?? null;
      if (revealed?.notes) notes = revealed.notes;
    } else if (record.passwordEncrypted) {
      secret = decrypt(record.passwordEncrypted);
    }

    // Reading a credential is worth its own audit entry — it is the one action
    // that exposes a secret, and the list view never does.
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      // The workspace this record lives in, already proven by
      // `resolveUtilityCompany`. Files it in that workspace's audit tab.
      companyId: scope.companyId,
      // ACTIONS.password has create/update/delete only; reveal is new.
      action: ACTIONS.password.view,
      details: auditSentence('view', {
        kind: 'password', name: record.title, member: record.holder?.name ?? null,
      }),
      req,
      entityType: 'passwords',
      entityId: record.id,
    });

    const { passwordEncrypted, ...safe } = record as any;
    return NextResponse.json({ success: true, password: { ...safe, notes, password: secret } });
  } catch (error) {
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    return serverError(error, 'loading password details');
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'passwords', 'edit');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value then scopes every
    // statement below, read and write alike — a predicate that guards only the
    // lookup guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    // withTenant, not bare `db`: `passwords` is RLS-FORCED, so a read without
    // app.tenant_id set matches zero rows and every edit 404s.
    const record = await withTenant(user.tenantId, (tx) => tx.query.passwords.findFirst({
      where: and(
        eq(passwords.id, id),
        eq(passwords.tenantId, user.tenantId),
        // The record's own account. Restated on every statement, including
        // the writes — a predicate that guards only the lookup guards nothing.
        inCompanyOf(passwords.companyId, scope.companyId),
        isNull(passwords.deletedAt),
      ),
      // See the note on the GET above.
      with: { holder: { columns: { name: true } } },
    }));

    if (!record) {
      return NextResponse.json({ error: 'Password credential not found' }, { status: 404 });
    }

    const body = await req.json();
    const parsed = passwordUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.format() }, { status: 400 });
    }

    const { title, category, url, username, password, notes, customFields } = parsed.data;

    // Holder is left alone unless the client actually sent the field, so a
    // partial update from some other caller cannot silently reassign a
    // credential to all members.
    const holderSent = parsed.data.holderId !== undefined;
    const holder = holderSent
      ? resolveHolder({ holderId: parsed.data.holderId })
      : { holderId: record.holderId, isGlobal: record.isGlobal };
    const holderName = holderSent
      ? (holder.holderId ? await assertHolderInTenant(user, holder.holderId) : null)
      : record.holder?.name ?? null;
    // A newly-sent holder must also belong to the workspace this credential
    // lives in. See src/lib/records/workspaceMembers.ts.
    if (holderSent && holder.holderId
      && !await isWorkspaceMember(user.tenantId, holder.holderId, scope.companyId)) {
      return NextResponse.json({ error: 'That member is not part of this workspace' }, { status: 400 });
    }

    const blocked = requireDriveConnected(user.tenant);
    if (blocked) return blocked;

    const ctx = {
      tenant: user.tenant,
      tenantId: user.tenantId,
      // Read off the request scope that already matched this row, so a reveal
      // or a delete opens the same vault the record was found in.
      companyId: scope.companyId,
      userId: user.id,
    };
    const previousKey = record.categoryModuleKey && record.categoryDocumentKey
      ? { moduleKey: record.categoryModuleKey, documentKey: record.categoryDocumentKey }
      : null;

    // The store rewrites its record whole, so an edit has to hand it every
    // field and not just the changed ones — a PUT of the title alone used to be
    // enough to blank the secret next to it.
    const next = {
      title: title ?? record.title,
      category: category ?? record.category,
      url: url ?? record.url,
      username: username ?? record.username,
      notes: notes ?? record.notes,
      customFields: customFields ?? (record.customFields as unknown[] | null) ?? [],
    };

    // No new secret in this request: read the current one back so the rewrite
    // carries it forward. Legacy rows still keep it in password_encrypted.
    let secret = password;
    if (secret === undefined) {
      if (previousKey) {
        const revealed = await revealPassword(ctx, previousKey, record.id);
        secret = revealed?.password ?? '';
      } else {
        secret = decrypt(record.passwordEncrypted);
      }
    }

    // Write-through to the vault. This route used to re-encrypt into the
    // deprecated password_encrypted column instead, which meant an edit never
    // reached the store and the next reveal returned the value from BEFORE it.
    const vault = await storePasswordInVault({
      tenant: user.tenant,
      tenantId: user.tenantId,
      companyId: scope.companyId,
      actorUserId: user.id,
      ownerId: record.userId,
      holderId: holder.holderId,
      isGlobal: holder.isGlobal,
      recordId: record.id,
      category: next.category,
      title: next.title,
      username: next.username,
      url: next.url,
      password: secret,
      notes: next.notes,
      customFields: next.customFields,
    });

    // The store file is named after the category, so renaming the category
    // moves the record. Drop the copy left behind in the old file.
    if (
      previousKey &&
      (previousKey.moduleKey !== vault.categoryModuleKey ||
        previousKey.documentKey !== vault.categoryDocumentKey)
    ) {
      await deletePasswordInVault(ctx, previousKey, record.id);
    }

    const updateData: any = {
      title: next.title,
      category: next.category || 'other',
      url: next.url,
      username: next.username,
      notes: next.notes,
      customFields: next.customFields,
      categoryModuleKey: vault.categoryModuleKey,
      categoryDocumentKey: vault.categoryDocumentKey,
      jsonDriveId: vault.jsonDriveId,
      keyVersion: vault.keyVersion,
      status: vault.status,
      // The secret now lives in the store, so the legacy column is cleared
      // rather than left holding a stale copy of it.
      passwordEncrypted: null,
    };
    if (holderSent) {
      updateData.holderId = holder.holderId;
      updateData.isGlobal = holder.isGlobal;
    }

    const { updated } = await withTenant(user.tenantId, async (tx) => {
      const [upd] = await tx.update(passwords)
        .set({ ...updateData, updatedAt: new Date() })
        .where(and(
          eq(passwords.id, id),
          eq(passwords.tenantId, user.tenantId),
          inCompanyOf(passwords.companyId, scope.companyId),
        ))
        .returning();

      // Log action
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this record lives in, already proven by
        // `resolveUtilityCompany`. Files it in that workspace's audit tab.
        companyId: scope.companyId,
        action: ACTIONS.password.update,
        details: auditSentence('update', {
          kind: 'password', name: upd.title, member: holderName,
        }),
        req,
        entityType: 'passwords',
        entityId: upd?.id,
      }, tx);

      return { updated: upd };
    });

    // Auto-update profile
    await autoUpdateProfile(record.userId, 'passwords', updated);

    const { passwordEncrypted, ...safe } = updated as any;
    return NextResponse.json({ success: true, password: { ...safe, password: secret } });
  } catch (error) {
    const holderError = holderErrorResponse(error);
    if (holderError) return holderError;
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    return serverError(error, 'updating password credential');
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'passwords', 'delete');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value then scopes every
    // statement below, read and write alike — a predicate that guards only the
    // lookup guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    // withTenant for the same reason as PUT: RLS is forced on this table.
    const record = await withTenant(user.tenantId, (tx) => tx.query.passwords.findFirst({
      where: and(
        eq(passwords.id, id),
        eq(passwords.tenantId, user.tenantId),
        // The record's own account. Restated on every statement, including
        // the writes — a predicate that guards only the lookup guards nothing.
        inCompanyOf(passwords.companyId, scope.companyId),
        isNull(passwords.deletedAt),
      ),
      // See the note on the GET above.
      with: { holder: { columns: { name: true } } },
    }));

    if (!record) {
      return NextResponse.json({ error: 'Password credential not found' }, { status: 404 });
    }

    await withTenant(user.tenantId, async (tx) => {
      await tx.update(passwords)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(passwords.id, id),
          eq(passwords.tenantId, user.tenantId),
          inCompanyOf(passwords.companyId, scope.companyId),
        ));

      // Log action
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this record lives in, already proven by
        // `resolveUtilityCompany`. Files it in that workspace's audit tab.
        companyId: scope.companyId,
        action: ACTIONS.password.delete,
        details: auditSentence('delete', {
          kind: 'password', name: record.title, member: record.holder?.name ?? null,
        }),
        req,
        entityType: 'passwords',
        entityId: id,
      }, tx);
    });

    return NextResponse.json({ success: true, message: 'Password credential deleted successfully' });
  } catch (error) {
    return serverError(error, 'deleting password credential');
  }
}
