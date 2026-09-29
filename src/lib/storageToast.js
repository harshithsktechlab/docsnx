'use client';

import { toast } from 'sonner';
import {
  STORAGE_WARN_RATIO,
  isOutOfSpaceBody,
  outOfSpaceMessage,
  storagePressure,
  storageUsageSentence,
} from '@/lib/storagePressure';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TELLING A TENANT THEY ARE OUT OF SPACE, BEFORE AND WHEN IT BITES      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two moments, one vocabulary:
 *
 *   - the write that was refused    → `toastStorageError`
 *   - the crossing into the last 15% → `maybeToastStoragePressure`
 *
 * Both name the actual numbers. "Storage full" with no figures leaves the user
 * unable to judge whether deleting one scan fixes it or they need a bigger
 * plan, and it was the whole complaint: a refused upload used to arrive as
 * "Internal Server Error" and a Drive filling up said nothing at all.
 *
 * The wording forks on WHOSE disk is full, because the remedies do not
 * overlap. A BYOD tenant frees space in their own Google Drive — an upgrade
 * here sells them nothing. A plan tenant cannot touch our storage and has to
 * buy an add-on.
 */

/** One key: the value IS the state warned about, so a change re-warns. */
const SEEN_KEY = 'storage_pressure_warned';

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

/**
 * Warns once when usage crosses into the last 15%, and again when it is full.
 *
 * Deduped in `sessionStorage` per state, not per page load. Shell calls this
 * on every `/api/auth/me`, which is every navigation — without the guard a
 * nearly-full tenant would be toasted on every click, which trains them to
 * dismiss the one warning that matters. Re-warns if they cross from 'warning'
 * to 'full', and forgets the dismissal once they free space, so the next
 * crossing warns again.
 *
 * @param {{currentBytes: number, limitBytes: number, unlimited?: boolean,
 *          isGoogleDrive?: boolean}|null} storageData from `clientGetMe`
 */
export function maybeToastStoragePressure(storageData) {
  const pressure = storagePressure(storageData);

  let seen = null;
  try {
    seen = sessionStorage.getItem(SEEN_KEY);
  } catch {
    // Private mode, or storage disabled. Warning every time beats never.
  }

  if (pressure === 'ok') {
    // Back below the line: forget the dismissal so a future crossing warns.
    if (seen) {
      try { sessionStorage.removeItem(SEEN_KEY); } catch { /* see above */ }
    }
    return;
  }
  if (seen === pressure) return;
  try { sessionStorage.setItem(SEEN_KEY, pressure); } catch { /* see above */ }

  const usage = storageUsageSentence(storageData?.currentBytes, storageData?.limitBytes);
  const where = storageData?.isGoogleDrive ? 'Google Drive' : 'storage';

  if (pressure === 'full') {
    toast.error(`Your ${where} is full`, {
      description: [usage, 'New uploads will be refused until you free space.']
        .filter(Boolean)
        .join(' · '),
      duration: 10000,
    });
    return;
  }

  toast.warning(`Your ${where} is almost full`, {
    description: [
      usage,
      `Less than ${Math.round((1 - STORAGE_WARN_RATIO) * 100)}% remaining.`,
      storageData?.isGoogleDrive
        ? 'Free up space in Google Drive to keep uploading.'
        : 'Consider adding storage to your plan.',
    ]
      .filter(Boolean)
      .join(' · '),
    duration: 8000,
  });
}

