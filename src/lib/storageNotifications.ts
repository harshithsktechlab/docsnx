import { withTenant } from './db';
import { notifications } from '../db/schema';
import { sendPushNotification } from './push';
import {
  STORAGE_WARN_RATIO,
  storagePressure,
  storageUsageSentence,
  type StorageStatus,
} from './storagePressure';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "YOUR DRIVE IS ALMOST FULL" LIVES IN THE BELL, NOT IN A POPUP          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This used to be a toast raised by Shell on every app load, which meant a
 * nearly-full tenant was greeted by it at the start of every session. It is a
 * standing condition, not an event, so it belongs in the notification list where
 * it waits to be read.
 *
 * Called from `/api/auth/me`, which already holds fresh storage figures. The
 * dedupe key makes the call idempotent, so being on that hot path costs one
 * `ON CONFLICT DO NOTHING` insert and only while the tenant is over the line.
 *
 * Refused uploads still toast (`toastStorageError`) — that is feedback for an
 * action the user just took, which is a different thing.
 */

export interface StorageNotice {
  title: string;
  message: string;
  link: string;
  dedupeKey: string;
}

/** Where the storage meter lives. */
const STORAGE_LINK = '/settings';

/**
 * The notice for a storage state, or null when there is nothing to say.
 *
 * The key carries the state and the month: warning → full files a second row
 * (escalation should speak), and a tenant that stays nearly full is reminded
 * once a month rather than once ever. Within a month, repeated calls collide on
 * the unique (tenant, user, dedupeKey) index and file nothing.
 */
export function storageNoticeFor(
  storageData: Pick<StorageStatus, 'currentBytes' | 'limitBytes' | 'unlimited' | 'isGoogleDrive'> | null | undefined,
  now: Date = new Date(),
): StorageNotice | null {
  const pressure = storagePressure(storageData);
  if (pressure === 'ok') return null;

  const usage = storageUsageSentence(storageData?.currentBytes, storageData?.limitBytes);
  const where = storageData?.isGoogleDrive ? 'Google Drive' : 'storage';
  const month = now.toISOString().slice(0, 7);
  const dedupeKey = `storage:${pressure}:${month}`;

  if (pressure === 'full') {
    return {
      title: `Your ${where} is full`,
      message: [usage, 'New uploads will be refused until you free space.'].filter(Boolean).join(' · '),
      link: STORAGE_LINK,
      dedupeKey,
    };
  }

  return {
    title: `Your ${where} is almost full`,
    message: [
      usage,
      `Less than ${Math.round((1 - STORAGE_WARN_RATIO) * 100)}% remaining.`,
      storageData?.isGoogleDrive
        ? 'Free up space in Google Drive to keep uploading.'
        : 'Consider adding storage to your plan.',
    ].filter(Boolean).join(' · '),
    link: STORAGE_LINK,
    dedupeKey,
  };
}

/**
 * Files the storage notice for `user` if there is one and it is not already on
 * their bell. Never throws: a failed notification must not take `/api/auth/me`
 * — and with it the whole session probe — down.
 */
export async function notifyStoragePressure(
  user: { id: string; tenantId: string; role?: string | null },
  storageData: Parameters<typeof storageNoticeFor>[0],
): Promise<void> {
  try {
    // A platform operator is not a tenant member; the bell returns nothing for them.
    if (user.role === 'SUPER_ADMIN') return;
    const notice = storageNoticeFor(storageData);
    if (!notice) return;

    const created = await withTenant(user.tenantId, async (tx) =>
      await tx
        .insert(notifications)
        .values({
          tenantId: user.tenantId,
          userId: user.id,
          // Account-level, like the plan-expiry notices: the Drive belongs to the
          // whole account, so it should show in Personal and in every business.
          companyId: null,
          accountScope: 'account',
          title: notice.title,
          message: notice.message,
          link: notice.link,
          isRead: false,
          dedupeKey: notice.dedupeKey,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id }),
    );

    // Push only for a row Postgres accepted, and outside the transaction.
    if (created.length > 0) {
      await sendPushNotification(user.id, notice.title, notice.message, notice.link);
    }
  } catch (err) {
    console.error('Storage notice failed for user', user.id, err);
  }
}
