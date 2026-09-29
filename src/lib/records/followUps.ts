/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FOLLOW-UPS — derived from the records, not from nine hardcoded rules   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What this replaces: `/api/follow-up` loaded NINE whole tables into memory on
 * every request — unfiltered, no date predicate, no limit — then applied a
 * per-table rule chain to find expiring things. `/api/follow-up/count` was a
 * near-verbatim copy of the same 400 lines, so the two could and did drift.
 *
 * Now a reminder is data. `toTaxonomyRecord` derives a `reminders` array when a
 * record is written — one entry per date-bearing field the module marks as a
 * deadline, each with its own label — and this reads them back. Adding a new
 * kind of renewal is a line in the field map, not a branch here.
 *
 * ── OVERDUE IS NOT RESOLVED ────────────────────────────────────────────────
 * A reminder whose date has passed is the MOST urgent thing on the page, not
 * something to filter out. `resolved` is set explicitly — a paid utility bill —
 * and only that removes an entry. Getting this backwards would make every item
 * silently vanish on the day it lapsed, which would look exactly like the
 * feature working.
 */
import { and, eq } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { hasCompanyAccess, hasPermission } from '@/lib/auth';
import { documents } from '@/db/schema';
import { readJsonStore } from '@/lib/vault/vaultRecords';
import { type CategoryKey, isSeededCategory } from '@/lib/documentCategories';
import { loadCategoryFieldSpec } from './categorySpec';
import { DEFAULT_ALERT_DAYS, recordAlertLeadDays } from './reminderPolicy';
import { renewalAction, renewalActionLabel } from './followUpActions';
import { visibleDocument } from './documentVisibility';
import { inCompanyOf } from './companyScope';
import { workspaceMembers } from './workspaceMembers';

/**
 * Days ahead that counts as "coming up" when NOTHING else answers.
 *
 * It used to be the only answer: every reminder in the app, on every category,
 * surfaced at fifteen days. It is now the last step of a chain — the record's own
 * `alert_days_before`, then the field's configured lead, then the dictionary's
 * per-key default, then this. See src/lib/records/reminderPolicy.ts.
 *
 * Kept under its old name and re-exported because several callers still use it
 * as their own fallback.
 */
export const ALERT_THRESHOLD_DAYS = DEFAULT_ALERT_DAYS;

export interface FollowUpItem {
  id: string;
  title: string;
  message: string;
  dueDate: string | Date;
  daysLeft: number;
  link: string;
  category: string;
  severity: 'URGENT' | 'WARNING' | 'INFO';
  module: string;

  /**
   * The window this item was actually judged against, in days.
   *
   * Carried rather than recomputed because the answer depends on three things
   * the caller does not have — the record's own `alert_days_before`, the
   * category's effective spec, and the dictionary's per-key default. The
   * notification ladder (src/lib/followUpNotifications.ts) needs it to decide
   * when a reminder "entered its window", and recomputing it there would be a
   * second copy of the chain, drifting from this one.
   */
  alertWindowDays: number;

  /**
   * ── THE SAME FACTS, UNFLATTENED ──────────────────────────────────────────
   * `message` is a sentence — "Rent Agreement: contract ends is overdue by 104
   * days" — which suits the follow-up page's single-line cards and nothing
   * else. Anywhere the document itself is the subject, that sentence buries the
   * one thing the reader is looking for: WHICH document. A summary rendering it
   * verbatim leaves the user unable to tell which record needs renewing, which
   * is exactly what was reported.
   *
   * So the parts are carried alongside it. `message` stays for the callers that
   * want prose; these let a caller lead with the record's name, label the date,
   * and link to the record itself.
   */
  recordId: string;
  recordTitle: string;
  /** The taxonomy field the date came from, e.g. `lease_to`. */
  fieldKey: string;
  /** That field's human label, e.g. "Lease To". */
  fieldLabel: string;
  documentKey: string;

  /**
   * ── THE ASK, NOT A GENERIC VERB ──────────────────────────────────────────
   * `actionLabel` is the card's button text and `recommendedAction` the line
   * under it. Both are derived from the category (src/lib/records/followUpActions.ts)
   * HERE rather than in the page, so the page, the sidebar count route and the
   * notification job cannot end up wording the same reminder three ways — the
   * drift this file's header was written about.
   *
   * `recommendedAction` says only HOW to clear it: `message` above already
   * names the record and how overdue it is, and repeating that would double
   * the card's text.
   */
  actionLabel: string;
  recommendedAction: string;
}

/** Whole days from today. Negative means the date has passed. */
export function daysUntil(date: string | Date | null | undefined): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const then = new Date(date);
  if (Number.isNaN(then.getTime())) return Number.POSITIVE_INFINITY;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  then.setHours(0, 0, 0, 0);
  return Math.round((then.getTime() - start.getTime()) / 86_400_000);
}

/**
 * How alarming an item is, judged against ITS OWN window.
 *
 * `window` used to be the global fifteen days, which stopped being right the
 * moment a field could ask for more: an insurance renewal with a 30-day lead
 * would enter the follow-up page at 30 days and render as INFO — the severity
 * that means "not due yet" — for a fortnight before turning WARNING. The card
 * appeared exactly when it should and looked like it did not matter.
 *
 * URGENT stays absolute. Three days is three days however much notice the field
 * asked for, and "overdue" is not relative to anything.
 */
function severityFor(days: number, window: number): FollowUpItem['severity'] {
  if (days < 0 || days <= 3) return 'URGENT';
  if (days <= window) return 'WARNING';
  return 'INFO';
}

/**
 * Where a reminder sends you: the sub-category workspace that holds the record.
 *
 * It used to be `/${module.replace(/_/g, '-')}`, which produced `/health-medical`
 * and `/bank-investments` — module keys are not routes, and none of those paths
 * exist. Every reminder therefore linked to a 404 for all but the handful of
 * modules whose key happened to match a page. `/modules/:moduleKey/:documentKey`
 * is derived from the record's own category and always resolves.
 */
function linkFor(key: CategoryKey, companyId?: string | null): string {
  // A business reminder must open the COMPANY's workspace. Linking a company's
  // expiring licence to `/modules/biz_licenses/...` would land on a route that
  // 400s — a business module addressed with no company — so the reminder would
  // be visible and unreachable, which is worse than not raising it.
  const prefix = companyId ? `/business/${companyId}` : '';
  return `${prefix}/modules/${key.moduleKey}/${key.documentKey}`;
}

/**
 * The reminders one category's records carry, as follow-up items.
 *
 * Split out so `/follow-up`, `/api/follow-up/count` and the sub-category
 * summary all read reminders the same way. They were one copy-pasted rule chain
 * per table before consolidation, and the two follow-up routes then drifted
 * from each other; this is the same mistake one level down, so there is exactly
 * one walk over a store's reminders.
 *
 * `rows` are the pointer rows for THIS category, already permission- and
 * tenant-filtered by the caller — `collectFollowUps` below and the module
 * counts route both drop a sub-category the member cannot `view` before they
 * get here, so this function never has to ask. A store that cannot be read
 * yields nothing rather than throwing: a Drive blip should cost one category's
 * reminders, not the whole page.
 */
export async function remindersForCategory(
  /**
   * `companyId` selects WHICH vault to open. Absent means the personal one —
   * which is the correct default for the fifteen personal callers, and the
   * silent wrong answer for a business record, whose store lives under
   * `business/<companyId>/` and would simply not be found.
   */
  ctx: { tenant: any; tenantId: string; userId: string; companyId?: string | null },
  key: CategoryKey,
  rows: ReadonlyArray<{ id: string; title: string | null }>,
  options: { thresholdDays?: number; strict?: boolean } = {},
): Promise<FollowUpItem[]> {
  const threshold = options.thresholdDays ?? ALERT_THRESHOLD_DAYS;
  /**
   * ── A NAMED THRESHOLD IS A HORIZON, NOT A DEFAULT ────────────────────────
   *
   * A caller that passes `thresholdDays` is asking a different question from
   * "what needs attention": the Summary tab wants the 30/60/90 horizon, the
   * module tiles want an expiry three years out, and both pass POSITIVE_INFINITY
   * to say so. Letting per-field windows apply there would narrow the answer back
   * down to the follow-up page's — a 60-day expiry would vanish from a tab that
   * had explicitly asked to see 90 days.
   *
   * So the per-field windows are what this function uses when NOBODY named a
   * horizon, which is the /follow-up, sidebar-badge and notification path. That
   * is the path the feature is for.
   */
  const perField = options.thresholdDays === undefined;

  /**
   * The category's effective spec — override over stored over dictionary — read
   * once per category rather than once per reminder.
   *
   * This is what makes an operator's change reach records already saved: the lead
   * time is resolved HERE, on every pass, instead of being stamped into the
   * reminder when the record was written.
   *
   * A spec that cannot be loaded costs the per-field windows, not the reminders:
   * every item then falls back to `threshold`, which is what this function did
   * before the feature existed.
   */
  let specByKey = new Map<string, { fieldKey: string; alertDaysBefore?: number }>();
  if (perField) {
    try {
      const specs = await loadCategoryFieldSpec(db, key);
      specByKey = new Map(specs.map((spec) => [spec.fieldKey, spec as any]));
    } catch (error) {
      console.error(`[follow-ups] spec for ${key.moduleKey}/${key.documentKey}:`, error);
    }
  }

  let records: Record<string, any> = {};
  try {
    // The vault module is the CATEGORY's module — the same rule the record
    // handler follows, since a page can span two and a store lives under one.
    const { store } = await readJsonStore(ctx as any, key.moduleKey as any, key);
    records = store.records ?? {};
  } catch (error) {
    // Degrading silently is right for a page aggregating every category — one
    // unreadable store must not empty the whole follow-up list. It is wrong for
    // a page ABOUT this category, which would then show "no renewals" when it
    // means "could not check", so that caller asks for the error instead.
    if (options.strict) throw error;
    return [];
  }

  const items: FollowUpItem[] = [];
  for (const row of rows) {
    const record = records[row.id];
    const reminders = (record?.reminders ?? []) as any[];
    for (const reminder of reminders) {
      if (reminder?.resolved) continue;
      const days = daysUntil(reminder?.date);
      /**
       * The window for THIS reminder on THIS record: the user's own answer if
       * they gave one, else the field's, else the dictionary's, else `threshold`.
       * `recordAlertLeadDays` owns that chain — see reminderPolicy.ts.
       */
      const window = perField
        ? recordAlertLeadDays(record, specByKey.get(reminder?.key) ?? { fieldKey: reminder?.key })
        : threshold;
      if (days > window) continue;

      const name = record?.name ?? row.title ?? 'Untitled record';
      const action = renewalAction(key.moduleKey, key.documentKey);
      items.push({
        /**
         * ── UNIQUE PER REMINDER, NOT PER FIELD ─────────────────────────────
         *
         * `slot` is set only where one field carries a LIST of dates — the
         * linked cards on a bank account, each with its own expiry. Without it
         * three cards on one account produce three items with one id, and
         * since this id is the notification dedupe key
         * (src/lib/followUpNotifications.ts), two of the three would be
         * silently dropped on insert.
         *
         * Appended rather than substituted, so every reminder that has no slot
         * keeps the id it has always had — a changed id would re-notify every
         * open reminder in every tenant once.
         */
        id: reminder.slot
          ? `${key.moduleKey}-${reminder.key}-${row.id}-${reminder.slot}`
          : `${key.moduleKey}-${reminder.key}-${row.id}`,
        title: days < 0 ? `${reminder.label} Overdue` : `${reminder.label} Due`,
        message: days < 0
          ? `${name}: ${reminder.label.toLowerCase()} is overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}.`
          : `${name}: ${reminder.label.toLowerCase()} is due in ${days} day${days === 1 ? '' : 's'}.`,
        dueDate: reminder.date,
        daysLeft: days,
        link: linkFor(key, ctx.companyId),
        category: 'renewals',
        severity: severityFor(days, window),
        module: key.moduleKey,
        alertWindowDays: window,
        recordId: row.id,
        recordTitle: name,
        fieldKey: reminder.key,
        fieldLabel: reminder.label,
        documentKey: key.documentKey,
        actionLabel: renewalActionLabel(key.moduleKey, key.documentKey, days),
        recommendedAction: action.how,
      });
    }
  }
  return items;
}

/**
 * The unresolved reminders on ONE record that are inside their own alert window.
 *
 * `remindersForCategory` above answers this for a whole category, from the vault
 * store. The two `generate-followups` routes (vehicles, investments) work from a
 * single already-loaded record instead, and each used to filter it with a bare
 * `daysUntil(r.date) <= ALERT_THRESHOLD_DAYS` — the global fifteen days, which
 * stopped being the answer the moment a field could ask for more. A to-do button
 * that says "nothing is due" about a policy the follow-up page is already
 * shouting about is the exact disagreement this file's header was written about.
 *
 * So the window is resolved here, through the same `recordAlertLeadDays` chain,
 * and both routes ask this rather than deriving it.
 *
 * A category that cannot be resolved falls back to the default window rather
 * than throwing: the button should still create the obvious to-dos.
 */
export async function remindersDueOnRecord(
  record: {
    fields?: Record<string, unknown> | null;
    reminders?: unknown;
    categoryModuleKey?: string | null;
    categoryDocumentKey?: string | null;
  },
): Promise<any[]> {
  const reminders = Array.isArray(record?.reminders) ? (record.reminders as any[]) : [];
  if (reminders.length === 0) return [];

  let specByKey = new Map<string, { fieldKey: string; alertDaysBefore?: number }>();
  if (record.categoryModuleKey && record.categoryDocumentKey) {
    try {
      const specs = await loadCategoryFieldSpec(db, {
        moduleKey: record.categoryModuleKey,
        documentKey: record.categoryDocumentKey,
      });
      specByKey = new Map(specs.map((spec) => [spec.fieldKey, spec as any]));
    } catch (error) {
      console.error('[follow-ups] spec for record category:', error);
    }
  }

  return reminders.filter((r) => {
    if (!r || r.resolved) return false;
    const window = recordAlertLeadDays(
      record.fields ?? null,
      specByKey.get(r.key) ?? { fieldKey: r.key },
    );
    return daysUntil(r.date) <= window;
  });
}

/**
 * Every record of this tenant that carries at least one unresolved reminder
 * falling within the threshold, RESTRICTED to the sub-categories this member
 * may view.
 *
 * One query and one store read per category the tenant actually uses, against
 * the nine full-table scans this replaces.
 *
 * ── WHY THE PERMISSION PASS IS HERE AND NOT IN THE ROUTES ──────────────────
 * This ran with no permission check at all: filtered by tenant and by
 * `visibleDocument()`, and nothing else. A member denied a sub-category still
 * got its record titles, its field labels and its due dates on `/follow-up` and
 * still had them counted in the sidebar badge — with each card linking to a
 * workspace that would then 403. Every other reader of these stores gates per
 * sub-category (`/api/modules/:moduleKey/counts`, the sub-category workspace,
 * `/api/document-categories`); the two follow-up routes were the gap.
 *
 * The check belongs in the shared builder rather than in each route because
 * those two routes were consolidated onto this function precisely because
 * duplicated rules drift — and they had already drifted once.
 */
export async function collectFollowUps(
  user: any,
  /**
   * Which workspace's renewals to collect. `null` is the household.
   *
   * This function used to span every workspace the member could reach, and the
   * page said so. It no longer does: a company workspace has its own Follow Up
   * now, so a single list mixing both would count a company's licence renewals
   * in the household's badge and show them on a page whose every other surface
   * is personal. Each workspace answers for itself.
   *
   * Not a permission. The company is proven by the caller — see
   * `resolveUtilityCompany` — and `mayReachCompany` below still re-checks each
   * row's own company before its store is opened.
   */
  companyId: string | null = null,
): Promise<FollowUpItem[]> {
  const rows = await withTenant(user.tenantId, async (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      // Which vault the record's reminders live in. Without it every business
      // record was looked up in the PERSONAL store, found nothing, and its
      // renewals — a licence lapsing, a GST registration expiring — were
      // dropped before anything read them. Silently, which is the worst way for
      // a reminder feature to fail.
      companyId: documents.companyId,
    })
      .from(documents)
      .where(and(
        eq(documents.tenantId, user.tenantId),
        inCompanyOf(documents.companyId, companyId),
        visibleDocument(),
      )),
  );

  // Grouped by (COMPANY, category) so each store is opened once.
  //
  // The company has to be part of the key, not just carried along: two
  // companies filing into `biz_licenses/trade_license` hold two separate
  // encrypted stores, and collapsing them onto one key would open whichever
  // company happened to be first and attribute both companies' rows to it.
  //
  // This used to skip any row whose `categoryModuleKey` was not in
  // RECORD_SCOPE_KEYS — comparing a TAXONOMY MODULE key against SCOPE keys, two
  // vocabularies that overlap in exactly two strings (`utility_bills` and
  // `tax_compliance`). Reminders for the other twelve modules — insurance
  // renewals, vehicle PUC and fitness, warranty expiry, rental agreements —
  // were discarded before anything read them, silently, on both follow-up
  // routes. A row's category pair is its own identity; it needs no scope.
  const byStore = new Map<string, { key: CategoryKey; companyId: string | null; rows: any[] }>();
  for (const row of rows) {
    if (!row.categoryModuleKey || !row.categoryDocumentKey) continue;
    if (!isSeededCategory(row.categoryModuleKey, row.categoryDocumentKey)) continue;
    const companyId = row.companyId ?? null;
    const k = `${companyId ?? ''}|${row.categoryModuleKey}/${row.categoryDocumentKey}`;
    const entry = byStore.get(k);
    if (entry) entry.rows.push(row);
    else byStore.set(k, {
      key: { moduleKey: row.categoryModuleKey, documentKey: row.categoryDocumentKey },
      companyId,
      rows: [row],
    });
  }

  /**
   * Both grains, asked once per group rather than once per row.
   *
   * `hasCompanyAccess` is not optional here even though this page only READS:
   * follow-ups are the one surface that aggregates every category a member can
   * see, so without it a member with no grant on Acme would still be told when
   * Acme's licences expire — the record's title and its renewal date, which is
   * most of what the record says.
   *
   * Cached per company because a workspace with five companies and ninety
   * categories would otherwise ask the same question ninety times.
   */
  const companyAllowed = new Map<string, boolean>();
  const mayReachCompany = async (companyId: string | null): Promise<boolean> => {
    if (!companyId) return true;
    const cached = companyAllowed.get(companyId);
    if (cached !== undefined) return cached;
    const allowed = await hasCompanyAccess(user, companyId);
    companyAllowed.set(companyId, allowed);
    return allowed;
  };

  // One `hasPermission` per DISTINCT category, not per row — a workspace with a
  // thousand records still asks at most once per sub-category, and a
  // TENANT_ADMIN short-circuits to true inside the helper. Done before any
  // store is opened, so a denied category costs no Drive read either.
  const permitted: Array<{ key: CategoryKey; companyId: string | null; rows: any[] }> = [];
  for (const entry of byStore.values()) {
    if (!await mayReachCompany(entry.companyId)) continue;
    if (await hasPermission(user, entry.key.moduleKey, 'view', entry.key.documentKey)) {
      permitted.push(entry);
    }
  }

  const items: FollowUpItem[] = [];

  for (const { key, companyId, rows: storeRows } of permitted) {
    const ctx = {
      tenant: user.tenant,
      tenantId: user.tenantId,
      userId: user.id,
      companyId,
    };
    items.push(...await remindersForCategory(ctx, key, storeRows));
  }

  // Most urgent first, overdue at the very top.
  return items.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE TWO DERIVED TABS — "you are missing this"                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Renewals are read off the records. These two are the opposite question —
 * what ISN'T on file — so they are derived from the absence of a row rather
 * than from a reminder, and they need the member list to say who is short.
 *
 * They live here, beside `collectFollowUps`, for the reason stated at the top
 * of this file: `/api/follow-up` and `/api/follow-up/count` are two views of
 * one answer, and every rule either of them keeps to itself drifts. The count
 * route omitted both of these tabs entirely, so the sidebar badge and the page
 * it links to disagreed about how much was outstanding.
 *
 * ── THE MODULE KEY IS `identity`, NOT `documents` ──────────────────────────
 * Both queries below used to filter on `categoryModuleKey = 'documents'`.
 * There is no such module: the master table (src/lib/documentCategories.ts)
 * files PAN and Aadhaar under `identity`, and `documents` is the name of the
 * TABLE, not of a taxonomy module. The predicate therefore matched no row
 * whatsoever, `held` and `heldByAll` were always empty, and every member was
 * told they had no PAN and no Aadhaar — permanently, and the moment after they
 * uploaded both. It renders as a working feature, which is why it survived: a
 * KYC tab that always says "missing" looks exactly like a KYC tab.
 */

/** The taxonomy module PAN and Aadhaar are filed under. */
const IDENTITY_MODULE = 'identity';

/** Identity papers every adult member is expected to hold. */
export const EXPECTED_ID_DOCUMENTS = [
  { documentKey: 'pan_card', label: 'PAN Card' },
  { documentKey: 'aadhaar_card', label: 'Aadhaar Card' },
] as const;

/**
 * The insurance sub-categories that answer "is this person covered?".
 *
 * NOT every category under the `insurance` module. That module also holds
 * `vehicle_policies` and `home_property_policies`, and counting those as cover
 * meant a member whose only policy was on their car was reported as having
 * health or life cover — which is what the card claims, in those words.
 */
export const PERSONAL_COVER_KEYS = [
  'life_policies',
  'health_policies',
  'term_policies',
] as const;

export interface GapItem {
  id: string;
  title: string;
  message: string;
  link: string;
  category: string;
  severity: 'URGENT' | 'WARNING' | 'INFO';
  /** How to close the gap — the card's "Recommended Action:" line. */
  recommendedAction: string;
}

export interface FollowUpGaps {
  insuranceGaps: GapItem[];
  documentsPending: GapItem[];
}

/**
 * The compliance and KYC tabs, for one member's view of their tenant.
 *
 * ── WHY THE PERMISSION PASS IS HERE TOO ────────────────────────────────────
 * `collectFollowUps` drops a sub-category the member cannot `view`; these two
 * tabs did not, and read `identity` and `insurance` for everyone. A member
 * denied those modules still learned which of their household is short of a
 * PAN, and got a card linking to a workspace that would then 403.
 *
 * The gates differ because the two claims differ:
 *
 *   · A KYC card names ONE document, so it is gated on that document's own
 *     sub-category — deny `aadhaar_card` and only that card disappears.
 *   · A cover gap card claims a member has NO personal policy at all. That is
 *     only true if every place such a policy could be filed was readable, so
 *     the tab is skipped unless the member may view all three. Answering from
 *     a partial read would invent a gap out of a permission.
 */
export async function collectGaps(user: any): Promise<FollowUpGaps> {
  // The HOUSEHOLD's members — this only ever runs for the personal workspace
  // (a company skips the gap tabs). Tenant-wide, it told the household that a
  // business-only employee had no PAN, no Aadhaar and no health cover.
  const members = await workspaceMembers(user.tenantId, null);

  const visibleIdKeys: Array<(typeof EXPECTED_ID_DOCUMENTS)[number]> = [];
  for (const expected of EXPECTED_ID_DOCUMENTS) {
    if (await hasPermission(user, IDENTITY_MODULE, 'view', expected.documentKey)) {
      visibleIdKeys.push(expected);
    }
  }

  let mayJudgeCover = true;
  for (const key of PERSONAL_COVER_KEYS) {
    if (!await hasPermission(user, 'insurance', 'view', key)) mayJudgeCover = false;
  }

  // Which members already hold which identity documents. One query, against
  // the per-user table scans this replaces.
  //
  // `isGlobal` is part of the answer, not a detail: it is how a record says
  // "all members" (see `holderFrom` in src/lib/recordRequest.ts), and such a
  // row carries no `holderId` at all. Reading only `holderId` filed every
  // all-members document under a holder that matches nobody.
  const idDocs = visibleIdKeys.length
    ? await withTenant(user.tenantId, async (tx) =>
      tx.select({
        holderId: documents.holderId,
        isGlobal: documents.isGlobal,
        documentKey: documents.categoryDocumentKey,
      })
        .from(documents)
        .where(and(
          eq(documents.tenantId, user.tenantId),
          // Household records only. A director's PAN filed inside a company
          // is that company's paper, not proof the household has it on file.
          inCompanyOf(documents.companyId, null),
          eq(documents.categoryModuleKey, IDENTITY_MODULE),
          visibleDocument(),
        )),
    )
    : [];
  /** Held by one named member. */
  const held = new Set(
    idDocs.filter((d: any) => d.holderId).map((d: any) => `${d.holderId}/${d.documentKey}`),
  );
  /** Filed for all members, so every member holds it. */
  const heldByAll = new Set(
    idDocs.filter((d: any) => d.isGlobal).map((d: any) => d.documentKey),
  );

  // ── ONE CARD PER MEMBER WHO IS ACTUALLY MISSING THE PAPER ────────────────
  // The condition used to be `!held.has(member/key) && !heldByAnyone.has(key)`,
  // and the second clause subsumed the first: a card appeared only when NOBODY
  // held that document, and then for EVERY member. Four members with no PAN
  // got four identical cards; the moment one of them filed a PAN the warning
  // vanished for the other three, who still had none. The card's own text —
  // "No PAN Card on file for Priya" — described a per-member check that was
  // not being made.
  const documentsPending: GapItem[] = members.flatMap((m: any) =>
    visibleIdKeys
      .filter(({ documentKey }) =>
        !heldByAll.has(documentKey) && !held.has(`${m.id}/${documentKey}`))
      .map(({ documentKey, label }) => ({
        id: `doc-missing-${m.id}-${documentKey}`,
        title: `${label} Missing`,
        message: `No ${label} on file for ${m.name}.`,
        // The sub-category's own workspace, which is where the paper is filed —
        // the same rule `linkFor` follows for renewals. `/documents` was the
        // whole list, leaving the reader to find the right category themselves.
        link: linkFor({ moduleKey: IDENTITY_MODULE, documentKey }),
        category: 'documents',
        severity: 'INFO' as const,
        recommendedAction: `Upload ${m.name}'s ${label} to complete their KYC record.`,
      })),
  );

  // A member with no health cover at all. Read from the records rather than
  // by string-matching an insured person's name against a user's, which is
  // what the previous implementation did.
  const policies = mayJudgeCover
    ? await withTenant(user.tenantId, async (tx) =>
      tx.select({
        holderId: documents.holderId,
        isGlobal: documents.isGlobal,
        documentKey: documents.categoryDocumentKey,
      })
        .from(documents)
        .where(and(
          eq(documents.tenantId, user.tenantId),
          // Household cover only — a company's group policy is not the
          // household's floater.
          inCompanyOf(documents.companyId, null),
          eq(documents.categoryModuleKey, 'insurance'),
          visibleDocument(),
        )),
    )
    : [];
  const coverKeys = new Set<string>(PERSONAL_COVER_KEYS);
  const personalCover = policies.filter((p: any) => coverKeys.has(p.documentKey));
  // A family floater is one policy covering everyone — the single most common
  // way an Indian household holds health cover, and the case that made this
  // tab report a gap for every member of a fully-insured tenant.
  const familyFloater = personalCover.some((p: any) => p.isGlobal);
  const covered = new Set(personalCover.map((p: any) => p.holderId).filter(Boolean));
  const insuranceGaps: GapItem[] = (!mayJudgeCover || familyFloater) ? [] : members
    .filter((m: any) => !covered.has(m.id))
    .map((m: any) => ({
      id: `insurance-gap-${m.id}`,
      title: 'No Health Cover Recorded',
      message: `${m.name} has no health or life policy on file.`,
      link: linkFor({ moduleKey: 'insurance', documentKey: 'health_policies' }),
      category: 'insurance',
      severity: 'WARNING' as const,
      // A floater already covers everyone, so this tab is empty when one
      // exists — but a household that files one AFTER seeing these cards
      // should be told that recording it is the fix, not buying more cover.
      recommendedAction: `Add ${m.name}'s health or life policy, or record the family floater that covers them.`,
    }));

  return { insuranceGaps, documentsPending };
}
