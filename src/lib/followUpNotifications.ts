/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TURNING A RENEWAL INTO SOMETHING THE BELL CAN SHOW                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The `notifications` table held zero rows, all time. Not a UI fault — the
 * panel, the API and the FCM stack are all correct and always were. It had
 * almost no writers: the plan-expiry ladder, which nothing scheduled, and a
 * to-do assignment, which fires only when you hand a task to someone else.
 *
 * Meanwhile the panel's own copy — "Active Alerts", and "All records up to
 * date!" when the list is empty (src/app/components/Shell.js) — promises
 * expiring records. That engine exists, is permission-gated and is already
 * trusted by two routes: `collectFollowUps` in src/lib/records/followUps.ts,
 * which the /follow-up page and its sidebar badge both read. It simply had no
 * way to reach the bell.
 *
 * This is that way. It adds NO expiry rules of its own — a rule that lived here
 * as well as in `followUps.ts` would drift from it, which is the mistake that
 * file's own header was written about.
 *
 * ── WHY A REMINDER ANNOUNCES ITSELF THREE TIMES, NOT THIRTY ────────────────
 * A renewal is a STANDING FACT, not an event: a policy lapsing in nine days is
 * equally true tomorrow. A daily job that simply inserted what it found would
 * file a fresh copy of every reminder every morning until the record was
 * renewed. That is the same feature broken in the other direction — a bell
 * nobody opens.
 *
 * So a reminder speaks at three moments in its life and is silent in between:
 * when it enters the 15-day window, when it turns urgent, and when it lapses.
 * `notifications.dedupe_key` plus its unique index is what enforces that —
 * see the stage ladder below and migration 0046.
 */
import { createHash } from 'crypto';
import { withTenant } from './db';
import { notifications } from '../db/schema';
import { sendPushNotification } from './push';
import { accessibleCompanies } from './auth';
import { axisLabel } from './billingAxis';
import { pushTitleFor } from './notifications';
import { accountScopeFor } from './records/companyScope';
import { workspaceMenu } from './workspaceNav';
import { collectFollowUps, type FollowUpItem } from './records/followUps';
import { DEFAULT_ALERT_DAYS } from './records/reminderPolicy';
import { followUpNoticeCopy, type NoticeCopy } from './records/followUpCopy';

/**
 * The ladder, earliest stage first.
 *
 * Deliberately shaped like `NOTICE_STAGES` in src/lib/planNotifications.ts —
 * the two jobs run in the same process and a reader who has understood one
 * should not have to learn a second vocabulary for the other. The difference is
 * where the "already sent" memory lives: a plan has one term and one tenant, so
 * it fits in a `tenants` column; a reminder is one of thousands, so its memory
 * is the notification row itself.
 */
export const FOLLOW_UP_STAGES = ['T-15', 'T-3', 'OVERDUE'] as const;
export type FollowUpStage = (typeof FOLLOW_UP_STAGES)[number];

/**
 * The stage a reminder is at, from its days-remaining and ITS OWN window.
 *
 * Thresholds match `severityFor` in followUps.ts — WARNING when it enters its
 * window, URGENT from three days out, and past-due — so the bell and the
 * follow-up page cannot disagree about how alarming something is.
 *
 * ── 'T-15' NO LONGER MEANS FIFTEEN ─────────────────────────────────────────
 * The window is now per field and per record (src/lib/records/reminderPolicy.ts),
 * so this stage means "entered its window", whatever that window is — 30 days
 * for an insurance renewal, 7 for a bill.
 *
 * The NAME is kept deliberately. It is part of `notifications.dedupe_key`, and
 * renaming it would make every already-announced reminder look unannounced and
 * re-buzz every member's phone once. A stage id is a storage key, not a label —
 * nothing user-facing renders it.
 *
 * `collectFollowUps` already drops anything beyond the window, so the null
 * branch is unreachable through the cron. It exists because this function is
 * the testable half of the decision and should answer for any input.
 */
export function stageForDaysLeft(
  daysLeft: number,
  windowDays: number = DEFAULT_ALERT_DAYS,
): FollowUpStage | null {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft < 0) return 'OVERDUE';
  if (daysLeft <= 3) return 'T-3';
  if (daysLeft <= windowDays) return 'T-15';
  return null;
}

/** `notifications.dedupe_key` is varchar(255). */
const DEDUPE_KEY_MAX = 255;

/**
 * The key that makes an insert idempotent: one row per reminder per stage.
 *
 * `FollowUpItem.id` is already stable and unique per record-and-field
 * (`${moduleKey}-${fieldKey}-${recordId}` — followUps.ts), so it needs no
 * invention here. The stage is part of the key rather than a column of its own
 * because "already told them, at this severity" is the exact question the
 * unique index has to answer.
 *
 * The length guard is not theoretical: `fieldKey` comes from the taxonomy,
 * which super admins edit (src/app/admin/document-fields). A long custom field
 * name must not silently truncate two different reminders into one key and
 * suppress the second — so anything oversized collapses to a digest of the
 * whole thing instead, which stays unique.
 */
export function dedupeKeyFor(item: Pick<FollowUpItem, 'id'>, stage: FollowUpStage): string {
  const key = `followup:${item.id}:${stage}`;
  if (key.length <= DEDUPE_KEY_MAX) return key;
  return `followup:${createHash('sha256').update(item.id).digest('hex')}:${stage}`;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE MEMBER, EVERY WORKSPACE THEY CAN REACH                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `collectFollowUps` collects ONE workspace — `companyId` null is the household
 * — because a company has its own Follow Up page and a single list mixing both
 * would count a company's licence renewals in the household's badge.
 *
 * This file called it once, with the default. So for the whole life of the
 * business account a company's renewals were collected by nothing: a licence
 * lapsing, a GST registration expiring, an insurance policy running out inside a
 * company were all dropped before any notice was written. Not a visible failure
 * — an empty bell looks exactly like a workspace with nothing due.
 */

/** One workspace to walk, and how a push should name it. */
interface FollowUpWorkspace {
  /** Null is the household. */
  companyId: string | null;
  /** Always set: 'Personal', or the company's name. What a dry run prints. */
  name: string;
  /**
   * The name a PUSH prefixes with, or null to send the title bare.
   *
   * Null on an account with a single workspace, where naming it is noise on
   * every message the user will ever receive — see `pushTitleFor`.
   */
  prefix: string | null;
}

/**
 * The workspaces this member's reminders live in.
 *
 * The household is walked UNCONDITIONALLY rather than behind a "does this member
 * have a personal half" test. `workspaceMenu().hasPersonal` looks like that test
 * and is not — it answers whether the SWITCHER should offer a Personal row, and
 * is false for the ordinary personal-only tenant, which is most of them. Reading
 * it here would have silently stopped the household reminders that already work.
 * A business-only tenant's household vault is empty, so the extra pass costs one
 * query returning nothing.
 *
 * The companies come from `accessibleCompanies` — the same permission-filtered
 * list /api/auth/me hands the switcher, so the cron cannot remind a member about
 * a workspace they cannot open. It returns nothing when the business half is
 * lapsed, which is correct: there is no use nagging someone about a locked
 * workspace.
 */
async function followUpWorkspaces(user: any): Promise<FollowUpWorkspace[]> {
  const companies = await accessibleCompanies(user);
  // `hasChoice` is exactly "would the app draw a workspace chip" — the question
  // the prefix answers. See the header of `pushTitleFor` for why this is not
  // `accountType === 'both'`.
  const named = workspaceMenu(user?.tenant?.accountType, companies, user).hasChoice;
  const personal = axisLabel('personal');

  return [
    { companyId: null, name: personal, prefix: named ? personal : null },
    ...companies.map((c) => ({
      companyId: c.id,
      name: c.name,
      prefix: named ? c.name : null,
    })),
  ];
}

/** A reminder due to be filed, with the workspace it was found in. */
interface DueNotice {
  item: FollowUpItem;
  stage: FollowUpStage;
  dedupeKey: string;
  copy: NoticeCopy;
  workspace: FollowUpWorkspace;
}

export interface FollowUpNotifyResult {
  /** Reminders in the window for this member, across every workspace. */
  considered: number;
  /** Rows this run actually filed — the rest had already been announced. */
  created: number;
  /** Push messages sent; never more than `created`. */
  pushed: number;
  /**
   * What each considered reminder WOULD say — dry runs only, empty otherwise.
   *
   * A dry run that reports counts alone cannot answer the question it is
   * usually run to answer: is the wording right for these records? The copy is
   * composed per sub-category (./records/followUpCopy.ts), so the only way to
   * see it against real data is to render it — and this lets the cron print it
   * without writing a row or buzzing a phone.
   *
   * Carries the workspace because the run now spans several of them, and a flat
   * list of titles cannot be checked against the records it came from when three
   * companies and a household are all reporting at once.
   */
  preview: Array<NoticeCopy & { workspace: string }>;
}

/**
 * File the reminders this member has not been told about yet, in every
 * workspace they can reach.
 *
 * `collectFollowUps` gates per sub-category, so a member is never notified
 * about a record they would be 403'd from opening — which is why this runs per
 * USER rather than once per tenant. The per-tenant store cache
 * (src/lib/vault/storeCache.ts) means the second and later members of a
 * workspace cost no additional Drive reads.
 *
 * `dryRun` reports the same decision without writing or sending, so the first
 * run against a live install can be read before it is believed.
 */
export async function notifyFollowUpsForUser(
  user: { id: string; tenantId: string; role?: string; tenant?: any; permissions?: any[] },
  options: { dryRun?: boolean } = {},
): Promise<FollowUpNotifyResult> {
  const workspaces = await followUpWorkspaces(user);

  const due: DueNotice[] = [];
  for (const workspace of workspaces) {
    const items = await collectFollowUps(user, workspace.companyId);
    for (const item of items) {
      // The item's own window, carried from `remindersForCategory` — see
      // FollowUpItem.alertWindowDays. Recomputing it here would be a second copy
      // of the resolution chain, which is the drift this file's header warns about.
      const stage = stageForDaysLeft(item.daysLeft, item.alertWindowDays);
      if (!stage) continue;
      due.push({
        item,
        stage,
        dedupeKey: dedupeKeyFor(item, stage),
        copy: followUpNoticeCopy(item),
        workspace,
      });
    }
  }

  if (options.dryRun || due.length === 0) {
    return {
      considered: due.length,
      created: 0,
      pushed: 0,
      preview: options.dryRun
        ? due.map((d) => ({ ...d.copy, workspace: d.workspace.name }))
        : [],
    };
  }

  /**
   * ON CONFLICT DO NOTHING, and the RETURNING is the point of it.
   *
   * The obvious alternative — read "have I sent this?", then insert — is a race
   * two overlapping runs both lose. It is also blind to what it did: only the
   * rows Postgres actually accepted are new, and those are exactly the ones
   * that deserve a push. Sending on everything found would re-buzz a member's
   * phone daily for a reminder they were told about last week.
   *
   * The dedupe key needs nothing added for the workspace: `FollowUpItem.id` is
   * `${moduleKey}-${fieldKey}-${recordId}` and the record uuid is unique across
   * every company, so two workspaces cannot collide on one key.
   */
  const created = await withTenant(user.tenantId, async (tx) =>
    await tx
      .insert(notifications)
      .values(due.map(({ item, dedupeKey, copy, workspace }) => ({
        tenantId: user.tenantId,
        userId: user.id,
        // Which workspace the bell should show this in. `item.link` already
        // points at `/business/<id>/…` for a company record (`linkFor` in
        // ./records/followUps.ts), so the row and the link agree by
        // construction rather than by a second decision made here.
        companyId: workspace.companyId,
        accountScope: accountScopeFor(workspace.companyId),
        // NOT the item's own pair — that is written for /follow-up, where the
        // card already sits in a category column beside its action button, and
        // it reduces to a field name ("Lease To Due") once lifted out of them.
        // `followUpNoticeCopy` restores the two things the bell has no other way
        // to show, the sub-category and the ask, and it does so by composing
        // lookups the page already uses rather than by writing a second set of
        // prose here — see ./records/followUpCopy.ts.
        title: copy.title,
        message: copy.message,
        link: item.link,
        isRead: false,
        dedupeKey,
      })))
      .onConflictDoNothing()
      .returning({
        id: notifications.id,
        title: notifications.title,
        message: notifications.message,
        link: notifications.link,
        companyId: notifications.companyId,
      })
  );

  // Which workspace each accepted row came from, to name it in the push. Keyed
  // off the returned company id rather than carried alongside: ON CONFLICT DO
  // NOTHING means the rows coming back are a SUBSET of what went in, in no
  // promised order, so pairing them up by position would mislabel them.
  const prefixes = new Map<string, string | null>(
    workspaces.map((w) => [w.companyId ?? '', w.prefix]),
  );

  // Outside the transaction: FCM round trips must not hold one open — the same
  // reason notifyAssignee (todoNotify.ts) and notifyPlanExpiry send out here.
  let pushed = 0;
  for (const row of created) {
    try {
      // The workspace is named in the PUSH only. A push lands on a locked phone
      // where there is no chip to read it off, and the bell row does not need it
      // — the panel is already scoped to one workspace. See ./notifications.ts.
      await sendPushNotification(
        user.id,
        pushTitleFor(row.title, prefixes.get(row.companyId ?? '')),
        row.message,
        row.link,
      );
      pushed += 1;
    } catch (err) {
      // A dead device must not cost the member the other notices, nor the row
      // that is already filed — the bell is the delivery that matters.
      console.error('Follow-up notice: push failed for user', user.id, err);
    }
  }

  return { considered: due.length, created: created.length, pushed, preview: [] };
}
