/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE STORAGE-PRESSURE RULE, SHARED BY SERVER AND BROWSER                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Deliberately its own module with NO imports. `src/lib/storage.ts` pulls in
 * the database, so a client component that wanted the threshold from there
 * would drag Drizzle into the browser bundle. The meter, the warning toast and
 * the server all read the numbers from here instead, which is the only way two
 * screens cannot disagree about whether a tenant is nearly full.
 */

/**
 * The fraction of a storage allowance that counts as "nearly full".
 *
 * One number, exported, because the amber meter, the warning toast and any
 * server-side decision must agree. Two thresholds that drifted apart would
 * warn a tenant on one screen and reassure them on the next.
 */
export const STORAGE_WARN_RATIO = 0.85;

export interface StorageStatus {
  allowed: boolean;
  currentBytes: number;
  limitBytes: number;
  /**
   * No measurable ceiling: a Drive tenant whose quota has never been read, or
   * a Workspace account with pooled storage that reports no limit at all.
   * `limitBytes` is `Infinity` in that case, which JSON.stringify turns into
   * `null` — callers that serialize this must send this flag instead of
   * relying on the number.
   */
  unlimited?: boolean;
  /** The figures describe the tenant's own Drive, not their plan allowance. */
  isGoogleDrive?: boolean;
  /** When the Drive figures were last read from Google. */
  quotaCheckedAt?: string | null;
  error?: string;
}

/**
 * How much of the allowance is gone, as one of three states the UI can act on.
 *
 * `unlimited` and a zero/absent limit both read as 'ok': a MISSING measurement
 * is not a full disk, and treating it as one would block a tenant whose only
 * fault is that we have not called Google yet.
 */
export function storagePressure(
  storage: Pick<StorageStatus, 'currentBytes' | 'limitBytes' | 'unlimited'> | null | undefined
): 'ok' | 'warning' | 'full' {
  if (!storage || storage.unlimited) return 'ok';
  const { currentBytes, limitBytes } = storage;
  if (!Number.isFinite(limitBytes) || !limitBytes || limitBytes <= 0) return 'ok';
  const ratio = currentBytes / limitBytes;
  if (ratio >= 1) return 'full';
  if (ratio >= STORAGE_WARN_RATIO) return 'warning';
  return 'ok';
}


const GB = 1024 * 1024 * 1024;

/**
 * Bytes as the tenant reads them on the meter, so the two agree.
 *
 * Lived in `storageToast.js` until the same sentence was needed by
 * `src/lib/net/apiErrorMessage.ts` — which has to describe a 507 in a FORM
 * banner, where a toast is the wrong surface. Two formatters would have let a
 * banner and a toast quote different figures for one refusal.
 */
export function formatStorageBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'unlimited';
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** "0.92 GB of 1.00 GB used", or null when there is no measurable ceiling. */
export function storageUsageSentence(
  currentBytes: number | null | undefined,
  limitBytes: number | null | undefined,
): string | null {
  if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return null;
  }
  return `${formatStorageBytes(currentBytes)} of ${formatStorageBytes(limitBytes)} used`;
}

/**
 * Does this response body mean "out of space"?
 *
 * Recognises both walls: `STORAGE_LIMIT_EXCEEDED` (the pre-flight in
 * src/lib/records/upload.ts) and `DRIVE_QUOTA_EXCEEDED` (Drive itself refusing
 * mid-write, from src/lib/vault/vaultErrors.ts). Both answer 507; a tenant does
 * not care which of the two stopped them.
 */
export function isOutOfSpaceBody(status: number | null | undefined, json: any): boolean {
  const code = json?.status;
  return status === 507 || code === 'STORAGE_LIMIT_EXCEEDED' || code === 'DRIVE_QUOTA_EXCEEDED';
}

/**
 * The two halves of an out-of-space message: what happened, and what to do.
 *
 * The wording forks on WHOSE disk is full, because the remedies do not overlap.
 * A BYOD tenant frees space in their own Google Drive — an upgrade here sells
 * them nothing. A plan tenant cannot touch our storage and has to buy an
 * add-on.
 */
export function outOfSpaceMessage(json: any): { title: string; description: string } {
  const usage = storageUsageSentence(json?.currentBytes, json?.limitBytes);
  // `isGoogleDrive` is absent on a DRIVE_QUOTA_EXCEEDED body — that code can
  // only ever mean the tenant's own Drive, so treat it as the Drive case.
  const onDrive = json?.isGoogleDrive ?? json?.status === 'DRIVE_QUOTA_EXCEEDED';
  return {
    title: onDrive ? 'Your Google Drive is full' : 'Storage limit reached',
    description: [
      usage,
      onDrive
        ? 'Free up space in Google Drive, then try again.'
        : 'Delete something you no longer need, or add storage to your plan.',
    ].filter(Boolean).join(' · '),
  };
}
