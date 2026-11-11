'use client';

import { toast } from 'sonner';
import { isOutOfSpaceBody, outOfSpaceMessage } from '@/lib/storagePressure';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TELLING A TENANT THEY ARE OUT OF SPACE, BEFORE AND WHEN IT BITES      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The write that was refused → `toastStorageError`.
 *
 * The earlier warning, on crossing into the last 15%, is no longer a toast: it
 * is a bell notification filed server-side (src/lib/storageNotifications.ts),
 * because a popup on every app load is noise for a standing condition.
 *
 * The message names the actual numbers. "Storage full" with no figures leaves the user
 * unable to judge whether deleting one scan fixes it or they need a bigger
 * plan, and it was the whole complaint: a refused upload used to arrive as
 * "Internal Server Error" and a Drive filling up said nothing at all.
 *
 * The wording forks on WHOSE disk is full, because the remedies do not
 * overlap. A BYOD tenant frees space in their own Google Drive — an upgrade
 * here sells them nothing. A plan tenant cannot touch our storage and has to
 * buy an add-on.
 */

/**
 * Reports a write refused for lack of space, and says whether it did.
 *
 * Returns `true` when it recognised and handled the response, so callers keep
 * their existing `else` branch for everything else:
 *
 *   if (!toastStorageError(res, json)) setFormError(json.error || 'Upload failed');
 *
 * Recognises both walls: `STORAGE_LIMIT_EXCEEDED` (the pre-flight in
 * src/lib/records/upload.ts) and `DRIVE_QUOTA_EXCEEDED` (Drive itself refusing
 * mid-write, from src/lib/vault/vaultErrors.ts). Both are 507; a tenant does
 * not care which of the two stopped them.
 *
 * @param {{status?: number}|null} res the fetch Response
 * @param {any} json its parsed body
 * @returns {boolean} true when a toast was raised
 */
export function toastStorageError(res, json) {
  if (!isOutOfSpaceBody(res?.status, json)) return false;
  const { title, description } = outOfSpaceMessage(json);
  toast.error(title, { description, duration: 8000 });
  return true;
}
