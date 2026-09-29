import type { CategoryKey } from '../documentCategories';
import { decryptField, encryptField } from '../fieldCrypto';
import type { TenantDriveRow } from '../googleDrive';
import { passwordCategoryKey } from './vaultNaming';
import {
  type ScopedVaultCtx, type VaultCtx, readJsonStore, softDeleteRecord, upsertRecord,
} from './vaultRecords';

/**
 * Passwords in the vault.
 *
 * Deliberately NOT `storeModuleFile`: a credential has no bytes to encrypt, only
 * a record. So this writes straight to the module's JSON store and skips the
 * file half entirely.
 *
 * Split, per the agreed policy:
 *   SEALED  password, notes, customFields
 *   OPEN    title, category, username, email, phone, url
 *
 * The open fields stay as plaintext searchable Postgres columns so the list and
 * its search keep working in SQL; only the secret leaves. Inside the store the
 * sealed values are additionally `encryptField`-ed, so the credential carries a
 * second layer beneath the store's own tenant-key seal.
 *
 * Password categories are free text, not the `document_categories` taxonomy, so
 * the store filename comes from `passwordCategoryKey` — the reserved
 * `passwords` module key plus the slugified free-text category.
 */

export interface PasswordVaultInput {
  tenant: TenantDriveRow & { id: string };
  tenantId: string;
  /**
   * Which company's vault this credential belongs to, or `null` for the
   * household's.
   *
   * REQUIRED, not optional, and for the reason spelled out on
   * `StoreDocumentFileInput.companyId`: an omitted scope does not fail, it
   * silently seals a company's credential into the PERSONAL store under the
   * personal AAD. No error is raised — the password is simply not there when
   * the company goes looking for it, which is the worst way for a vault to be
   * wrong. Making it required turns every missed call site into a compile error.
   */
  companyId: string | null;
  actorUserId: string;
  ownerId: string;
  recordId: string;
  /** Free-text category; slugified into the store filename. */
  category?: string | null;
  title: string;
  username?: string | null;
  url?: string | null;
  /** The secret. Never written to Postgres. */
  password: string;
  notes?: string | null;
  customFields?: unknown;
  holderId?: string | null;
  isGlobal?: boolean;
}

export interface PasswordVaultColumns {
  categoryModuleKey: string;
  categoryDocumentKey: string;
  jsonDriveId: string;
  keyVersion: number;
  status: 'active';
}

export async function storePasswordInVault(
  input: PasswordVaultInput
): Promise<PasswordVaultColumns> {
  const categoryKey = passwordCategoryKey(input.category);
  const ctx: VaultCtx = {
    tenant: input.tenant,
    tenantId: input.tenantId,
    // Selects the Drive folder tree AND the AAD the secret is sealed under.
    companyId: input.companyId,
    userId: input.actorUserId,
  };
  const now = new Date().toISOString();

  const { jsonDriveId } = await upsertRecord(
    ctx,
    'passwords',
    categoryKey,
    input.recordId,
    (previous: any) => ({
      ...(previous ?? {}),
      id: input.recordId,
      userId: input.ownerId,
      holderId: input.holderId ?? null,
      isGlobal: input.isGlobal ?? false,
      categoryModuleKey: categoryKey.moduleKey,
      categoryDocumentKey: categoryKey.documentKey,
      // Mirrors of the searchable Postgres columns, so the store alone is a
      // complete record — a restore does not need the database to make sense.
      open: {
        title: input.title,
        category: input.category ?? null,
        username: input.username ?? null,
        url: input.url ?? null,
      },
      sealed: {
        password: encryptField(input.password),
        notes: input.notes ? encryptField(input.notes) : null,
        customFields: input.customFields ? encryptField(JSON.stringify(input.customFields)) : null,
      },
      status: 'active',
      createdAt: previous?.createdAt ?? now,
      createdBy: previous?.createdBy ?? input.actorUserId,
      updatedAt: now,
      updatedBy: input.actorUserId,
      deletedAt: null,
    })
  );

  return {
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    jsonDriveId,
    keyVersion: 1,
    status: 'active',
  };
}

export interface RevealedPassword {
  password: string | null;
  notes: string | null;
  customFields: unknown;
}

/**
 * Reads one credential's secret back out of the store.
 *
 * Server-side by design: the sealed values here use `encryptField` under
 * ENCRYPTION_SECRET, inside a store sealed with the tenant key — both of which
 * this process holds. The browser-held vault key is a later phase; when it
 * lands, this is the function that moves to the client.
 *
 * `ctx` is a `ScopedVaultCtx`: the account has to be written out, because the
 * store this opens has to be the one `storePasswordInVault` wrote to. A ctx
 * without it opened the personal store and returned null for every company
 * credential — see the note on the type.
 */
export async function revealPassword(
  ctx: ScopedVaultCtx,
  categoryKey: CategoryKey,
  recordId: string
): Promise<RevealedPassword | null> {
  const { store } = await readJsonStore<any>(ctx, 'passwords', categoryKey);
  const record = store.records?.[recordId];
  if (!record || record.deletedAt) return null;

  const sealed = record.sealed ?? {};
  let customFields: unknown = null;
  if (sealed.customFields) {
    try {
      customFields = JSON.parse(decryptField(sealed.customFields) ?? 'null');
    } catch {
      customFields = null;
    }
  }

  return {
    password: sealed.password ? decryptField(sealed.password) : null,
    notes: sealed.notes ? decryptField(sealed.notes) : null,
    customFields,
  };
}

/**
 * Marks a credential deleted in the store, keeping it so a restore is possible.
 *
 * Same `ScopedVaultCtx` as the reveal, and for a sharper reason: an unscoped
 * delete does not miss quietly, it soft-deletes in the PERSONAL store — either
 * nothing, or the household's record of the same id.
 */
export async function deletePasswordInVault(
  ctx: ScopedVaultCtx,
  categoryKey: CategoryKey,
  recordId: string
): Promise<void> {
  await softDeleteRecord(ctx, 'passwords', categoryKey, recordId);
}
