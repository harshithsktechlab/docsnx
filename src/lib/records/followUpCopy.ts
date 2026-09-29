/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT A RENEWAL SOUNDS LIKE IN THE BELL                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A follow-up item's own `title`/`message` pair is written for /follow-up, where
 * the card sits in a category column beside an action button:
 *
 *   Policy End Date Due
 *   Star Health Family Floater: policy end date is due in 9 days.
 *
 * Lift that into the notification bell — which has neither column nor button —
 * and both of the reader's questions go unanswered: WHICH part of the vault this
 * came from, and what they are supposed to do about it. The heading is a field
 * name, and a field name is the one thing they were not looking for.
 *
 * So the bell's wording is composed here instead:
 *
 *   Health insurance policies · due in 9 days
 *   Star Health Family Floater — policy end date is due in 9 days.
 *   Pay the renewal premium and file the new policy schedule.
 *
 * ── DERIVED, NOT WRITTEN ───────────────────────────────────────────────────
 * Every fragment above already existed and was already trusted somewhere else:
 * the sub-category name is `categoryDisplay` (src/lib/documentCategories.ts),
 * which titles the record's own workspace, and the closing sentence is
 * `renewalAction().how` (./followUpActions.ts), which /follow-up prints verbatim
 * as "Recommended Action:". Nothing here invents per-category prose — that is
 * the second copy followUps.ts's header was written about, and it would drift
 * from the page within a release.
 *
 * No I/O, and every import is a pure lookup, on purpose: this decides what a
 * notice says and stays testable as a pure function (tests/followUpCopy.test.ts).
 */
import { categoryDisplay } from '@/lib/documentCategories';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { renewalAction } from './followUpActions';
import type { FollowUpItem } from './followUps';

export interface NoticeCopy {
  title: string;
  message: string;
}

/** `notifications.title` is varchar(255) — see src/db/schema.ts. */
const TITLE_MAX = 255;

/**
 * The sub-category name, without the parenthetical the master table carries.
 *
 * Seeded names are written for a settings table, where the qualifier earns its
 * place: "Health insurance policies (individual + family floater)", "Aadhaar
 * Card (all members)", "Khata / mutation certificates (state-specific land
 * records)". A bell heading is a glance, and the qualifier is what pushes it
 * past the width of the panel.
 *
 * Only a TRAILING parenthetical goes: "Pollution Under Control (PUC)
 * certificate" carries its bracket mid-name, where it is the actual noun.
 */
function shortSubCategory(documentName: string): string {
  return documentName.replace(/\s*\([^()]*\)\s*$/, '').trim() || documentName;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * How the date stands, as a phrase that reads correctly in both the heading
 * ("· due in 9 days") and mid-sentence ("policy end date is due in 9 days").
 *
 * Due TODAY is its own case rather than "due in 0 days" — the same day-of-grace
 * distinction `stageForDaysLeft` makes when it calls day zero T-3 and not
 * OVERDUE (src/lib/followUpNotifications.ts).
 */
export function urgencyPhrase(daysLeft: number): string {
  if (daysLeft < 0) return `overdue by ${plural(Math.abs(daysLeft), 'day')}`;
  if (daysLeft === 0) return 'due today';
  return `due in ${plural(daysLeft, 'day')}`;
}

/**
 * The bell's wording for one reminder.
 *
 * Falls back to the item's own pair for a category the master table does not
 * know. That is unreachable through `collectFollowUps`, which drops any row
 * failing `isSeededCategory` before it builds an item — but a function that
 * decides what a user reads must answer for any input, and "identity/pan_card ·
 * due in 9 days" (a key, rendered at a human) would be worse than the wording
 * this replaces.
 */
export function followUpNoticeCopy(item: FollowUpItem): NoticeCopy {
  /**
   * ── DESCRIBED BY WHERE IT LIVES, NOT BY WHICH DOOR IT CAME THROUGH ───────
   * A mirror alias is an address, not a place (src/lib/categoryMirrors.ts).
   * Nothing is filed under one any more, but rows that predate the mirror still
   * carry `vehicle/insurance_cross_ref`, and describing such a record by its
   * alias hands a motor policy the Vehicle module's verb: "renew at the RTO",
   * for something you renew by paying a premium. Resolving first asks the
   * category the record actually lives in.
   *
   * The item's own `link` is left alone — an alias URL read-resolves to the
   * canonical listing, which is the module tile the user clicked from.
   */
  const key = canonicalCategory({ moduleKey: item.module, documentKey: item.documentKey });
  const display = categoryDisplay(key);
  if (!display) return { title: item.title, message: item.message };

  const urgency = urgencyPhrase(item.daysLeft);
  const title = `${shortSubCategory(display.documentName)} · ${urgency}`;

  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
    message: `${item.recordTitle} — ${item.fieldLabel.toLowerCase()} is ${urgency}. `
      + renewalAction(key.moduleKey, key.documentKey).how,
  };
}
