/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   RECORD ATTACHMENTS — photos kept beside a record's own document        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A record owns ONE document (its pages are that document, split). A piece of
 * jewellery wants two things: the bill it was bought on, and what it looks
 * like. So the bill stays the primary file — the scan can still read the
 * jeweller, the date and the weight off it — and the photos ride alongside as
 * attachments (0069).
 *
 * ── WHERE THEY LIVE ────────────────────────────────────────────────────────
 * On the record's entry in its category's Drive JSON store, as `attachments[]`,
 * next to `pages[]`. Each photo is its own sealed Drive object under the
 * category folder, sealed with its own `fileId` (`att-<uuid>`, thumbnail
 * `att-<uuid>-t`) so it is bound to its slot exactly as a page is. Postgres
 * holds only the byte total (`documents.attachment_size`), for the quota.
 *
 * `storeRecordInVault` spreads the previous entry, so a body edit or an
 * invoice replacement keeps the list; `removeRecordFromStore` purges it with
 * the record.
 *
 * ── ENABLED PER CATEGORY ───────────────────────────────────────────────────
 * Only the categories in ATTACHMENT_SLOTS take photos. The upload route refuses
 * every other, so this cannot quietly become a second, unmetered file store
 * for the whole taxonomy.
 *
 * Leaf module, no imports: the form reads the slot to know whether to draw the
 * photo strip, and the routes read it to refuse what it does not allow.
 */

export interface AttachmentSlot {
  readonly kind: 'photo';
  /** Heading over the photo strip. */
  readonly label: string;
  /** What the record's ordinary file is called in this category. */
  readonly primaryFileLabel: string;
  readonly max: number;
  readonly maxBytes: number;
  readonly accept: readonly string[];
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const ATTACHMENT_SLOTS: Readonly<Record<string, AttachmentSlot>> = {
  'bank_investments/locker_items': {
    kind: 'photo',
    label: 'Photos of the item',
    primaryFileLabel: 'Invoice / bill',
    max: 6,
    // After the browser's downscale a phone photo is well under this; the cap
    // is for a request that skipped it.
    maxBytes: 8 * 1024 * 1024,
    accept: PHOTO_TYPES,
  },
};

export function attachmentSlotFor(
  key: { moduleKey: string; documentKey: string } | null | undefined,
): AttachmentSlot | null {
  if (!key) return null;
  return ATTACHMENT_SLOTS[`${key.moduleKey}/${key.documentKey}`] ?? null;
}

/** One stored attachment, as the Drive JSON holds it. Server-side only. */
export interface StoredAttachment {
  id: string;
  kind: 'photo';
  driveFileId: string;
  mimeType: string;
  size: number;
  contentHash: string;
  name: string;
  thumb?: { fileId: string; driveFileId: string; size: number } | null;
  createdAt: string;
  createdBy: string;
}

/** What a client is told about one: no Drive ids, no hashes. */
export interface AttachmentSummary {
  id: string;
  kind: 'photo';
  mimeType: string;
  size: number;
  name: string;
  hasThumb: boolean;
  createdAt: string;
}

const ATTACHMENT_ID = /^att-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID.test(value);
}

export function storedAttachments(record: unknown): StoredAttachment[] {
  const list = (record as { attachments?: unknown } | null | undefined)?.attachments;
  return Array.isArray(list) ? list.filter((a) => a && isAttachmentId((a as any).id)) : [];
}

export function findAttachment(record: unknown, id: string): StoredAttachment | null {
  if (!isAttachmentId(id)) return null;
  return storedAttachments(record).find((a) => a.id === id) ?? null;
}

/** The allowlisted projection for list and record responses. */
export function summariseAttachments(record: unknown): AttachmentSummary[] {
  return storedAttachments(record).map((a) => ({
    id: a.id,
    kind: a.kind,
    mimeType: a.mimeType,
    size: a.size,
    name: a.name,
    hasThumb: Boolean(a.thumb),
    createdAt: a.createdAt,
  }));
}
