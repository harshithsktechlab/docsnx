/**
 * Adding and removing a record's photo attachments (0069) — see
 * src/lib/records/recordAttachments.ts for what they are and where they live.
 *
 * The order is the same one `storeRecordInVault` keeps: bytes to Drive FIRST,
 * then the JSON entry under the store lock. A failed upload therefore never
 * leaves an entry pointing at nothing; a failed store write leaves an upload
 * nothing points at, which is discarded here before the error goes on.
 */
import crypto from 'crypto';
import type { CategoryKey } from '../documentCategories';
import type { TenantDriveRow } from '../googleDrive';
import { purgeDocumentFiles, storeDocumentFile } from './vaultFiles';
import { upsertRecord } from './vaultRecords';
import { discardVaultFile } from './vaultStore';
import type { VaultModule } from './vaultNaming';
import { VaultError } from './vaultErrors';
import {
  type AttachmentSlot, type StoredAttachment, storedAttachments,
} from '../records/recordAttachments';

export interface AttachmentTarget {
  tenant: TenantDriveRow & { id: string };
  tenantId: string;
  /** The RECORD's company, read off its row — never the request's. */
  companyId: string | null;
  actorUserId: string;
  /** The record's owner, for the Drive object's ownership tags. */
  ownerId: string;
  recordId: string;
  categoryKey: CategoryKey;
}

/** The record already holds as many photos as its slot allows. */
export class AttachmentLimitError extends Error {
  constructor(max: number) {
    super(`An item can hold at most ${max} photos.`);
    this.name = 'AttachmentLimitError';
  }
}

export async function addRecordAttachment(
  target: AttachmentTarget,
  slot: AttachmentSlot,
  photo: { bytes: Buffer; mimeType: string; name: string },
  thumb: { bytes: Buffer } | null,
): Promise<StoredAttachment> {
  const id = `att-${crypto.randomUUID()}`;
  const base = {
    tenant: target.tenant,
    companyId: target.companyId,
    documentId: target.recordId,
    ownerId: target.ownerId,
    categoryKey: target.categoryKey,
  };

  const stored = await storeDocumentFile({ ...base, bytes: photo.bytes, fileId: id });
  let storedThumb: { fileId: string; driveFileId: string; size: number } | null = null;
  try {
    if (thumb) {
      const thumbId = `${id}-t`;
      const t = await storeDocumentFile({ ...base, bytes: thumb.bytes, fileId: thumbId });
      storedThumb = { fileId: thumbId, driveFileId: t.driveFileId, size: thumb.bytes.length };
    }
  } catch (error) {
    await discardVaultFile(target.tenant, stored.driveFileId);
    throw error;
  }

  const entry: StoredAttachment = {
    id,
    kind: 'photo',
    driveFileId: stored.driveFileId,
    mimeType: photo.mimeType,
    size: photo.bytes.length,
    contentHash: stored.contentHash,
    name: photo.name.slice(0, 200),
    thumb: storedThumb,
    createdAt: new Date().toISOString(),
    createdBy: target.actorUserId,
  };

  try {
    await upsertRecord<any>(
      {
        tenant: target.tenant,
        tenantId: target.tenantId,
        companyId: target.companyId,
        userId: target.actorUserId,
      },
      target.categoryKey.moduleKey as VaultModule,
      target.categoryKey,
      target.recordId,
      (previous) => {
        // Never CREATE a record from here: a photo for an id the store does not
        // hold is a race with a delete, and inventing an entry would resurrect
        // half a record.
        if (!previous || previous.status === 'deleted') {
          throw new VaultError('VAULT_FILE_MISSING', `record ${target.recordId} is not in its store`);
        }
        const list = storedAttachments(previous);
        // Counted INSIDE the lock, so two uploads racing for the last slot
        // cannot both win.
        if (list.length >= slot.max) throw new AttachmentLimitError(slot.max);
        return { ...previous, attachments: [...list, entry] };
      },
    );
  } catch (error) {
    await discardVaultFile(target.tenant, entry.driveFileId);
    if (storedThumb) await discardVaultFile(target.tenant, storedThumb.driveFileId);
    throw error;
  }

  return entry;
}

/**
 * Remove one attachment. Returns what was removed (for the byte count), or
 * null when the record held no such attachment.
 *
 * The entry leaves the store first and the Drive objects are purged after —
 * the reverse would leave an entry whose bytes are gone.
 */
export async function removeRecordAttachment(
  target: AttachmentTarget,
  attachmentId: string,
): Promise<StoredAttachment | null> {
  const removed: { value: StoredAttachment | null } = { value: null };

  await upsertRecord<any>(
    {
      tenant: target.tenant,
      tenantId: target.tenantId,
      companyId: target.companyId,
      userId: target.actorUserId,
    },
    target.categoryKey.moduleKey as VaultModule,
    target.categoryKey,
    target.recordId,
    (previous) => {
      if (!previous) {
        throw new VaultError('VAULT_FILE_MISSING', `record ${target.recordId} is not in its store`);
      }
      const list = storedAttachments(previous);
      removed.value = list.find((a) => a.id === attachmentId) ?? null;
      return { ...previous, attachments: list.filter((a) => a.id !== attachmentId) };
    },
  );

  const gone = removed.value;
  if (gone) {
    const { failed } = await purgeDocumentFiles(
      target.tenant,
      [gone.driveFileId, gone.thumb?.driveFileId].filter(Boolean) as string[],
    );
    for (const f of failed) {
      console.error(`[vault] could not purge attachment object ${f.driveFileId}:`, f.error);
    }
  }
  return gone;
}
