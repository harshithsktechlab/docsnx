import { and, eq, isNull } from 'drizzle-orm';
import { db, withTenant } from './db';
import { notifications, tenants, users, subscriptionPlans } from '../db/schema';
import { sendPushNotification } from './push';
import { sendPlanExpiryEmail } from './mailer';
import { getAppBaseUrl } from './appUrl';
import { axesForAccountType, daysUntil, type AccountAxis } from './planGate';
import { axisLabel, axisRow } from './billingAxis';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   Telling a tenant their subscription is about to lapse — or has         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three channels, because an expiry that locks the whole workspace should not
 * depend on the user happening to open the app: the in-app bell (`notifications`,
 * which Shell polls every 60s), FCM push to their registered devices, and email.
 *
 * Sent to EVERY member of the tenant, not just the admin: the lock affects all of
 * them, and a member who does not know why the app went dark files a bug instead
 * of nudging the person who can pay. Only the admin's copy carries the renew
 * link; a member's names the admin to ask.
 *
 * Idempotency lives in `tenants.plan_notice_stage`: the daily job would otherwise
 * repeat the same notice on all three channels every day a plan stayed lapsed.
 * `applyPlanToTenant` clears the column, which re-arms the sequence on renewal.
 *
 * ── TWO LADDERS, ONE PER AXIS ──────────────────────────────────────────────
 * Since 0057 a tenant holds a personal plan and a business plan, on their own
 * dates. This file ran one ladder, off `subscription_expiry` — which since that
 * migration means the HOUSEHOLD's plan alone — so a lapsing business plan said
 * nothing at all and the company workspace locked at T-0 with no warning.
 *
 * Every function below therefore takes an AXIS and reads that half through
 * `axisRow` (src/lib/billingAxis.ts) rather than the `subscription*` columns
 * directly. The stage column is per axis too (`business_plan_notice_stage`):
 * stages only move forward within a term, so a household plan sitting at
 * 'EXPIRED' in one shared column would have swallowed every business notice
 * behind it.
 *
 * ── AND ONE LADDER'S NOTICES DO NOT GO TO THE OTHER HALF'S MEMBERS ─────────
 * `users.account_scope` says which account a member was added to. A member
 * hired to work on a company has no household records and cannot pay for one,
 * so the household's renewal notice is noise to them on all three channels —
 * and it names a plan they have no way to see. The TENANT_ADMIN spans both, as
 * they do everywhere else.
 */

/** The reminder ladder, latest stage last — order defines "already past this". */
export const NOTICE_STAGES = ['T-7', 'T-3', 'T-1', 'EXPIRED'] as const;
export type NoticeStage = (typeof NOTICE_STAGES)[number];

/**
 * The stage a term is due, from its days-remaining — or null when it is not at
 * a milestone (day 12 of a monthly plan announces nothing).
 */
export function stageForDaysLeft(daysLeft: number | null): NoticeStage | null {
  if (daysLeft === null) return null; // lifetime plan: nothing to announce, ever.
  if (daysLeft < 0) return 'EXPIRED';
  if (daysLeft <= 1) return 'T-1';
  if (daysLeft <= 3) return 'T-3';
  if (daysLeft <= 7) return 'T-7';
  return null;
}

/** Has `sent` already covered `due`? Stages only ever move forward within a term. */
export function stageAlreadySent(sent: string | null | undefined, due: NoticeStage): boolean {
  if (!sent) return false;
  const sentIdx = NOTICE_STAGES.indexOf(sent as NoticeStage);
  if (sentIdx === -1) return false;
  return sentIdx >= NOTICE_STAGES.indexOf(due);
}

/**
 * The notice's words.
 *
 * `half` is 'Personal' / 'Business' on an account that HAS two halves, and null
 * on one that does not — where naming it is noise, the same rule
 * /billing/expired applies to its own heading. With `half` null every string
 * below is byte-identical to what this function produced before there were two
 * axes, which is what keeps the single-half tenant (still most of them) from
 * noticing this change at all.
 */
function copyFor(stage: NoticeStage, planName: string | null, daysLeft: number, half: string | null) {
  const plan = planName || 'Your subscription';
  // "Business plan expires in 3 days" — the half goes in the TITLE because that
  // is the line a push and a lock screen show; a body is truncated first.
  const noun = half ? `${half} plan` : 'Plan';
  const theWorkspace = half ? `the ${half} workspace` : 'the workspace';
  const TheWorkspace = half ? `The ${half} workspace` : 'The workspace';

  if (stage === 'EXPIRED') {
    return {
      title: `${noun} expired`,
      message: `${plan} has expired. ${TheWorkspace} is locked until it is renewed — no records have been deleted.`,
    };
  }
  if (daysLeft <= 0) {
    return {
      title: `${noun} expires today`,
      message: `${plan} expires today. Renew it to avoid ${theWorkspace} locking.`,
    };
  }
  return {
    title: `${noun} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    message: `${plan} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew it to avoid ${theWorkspace} locking.`,
  };
}

export interface NotifyResult {
  /** Which half this notice was about. */
  axis: AccountAxis;
  stage: NoticeStage;
  recipients: number;
  emailed: number;
  pushed: number;
}

/** The stage columns for one axis. Keeps the two ladders from sharing a memory. */
function stageColumnsFor(axis: AccountAxis, stage: NoticeStage): Record<string, unknown> {
  const now = new Date();
  if (axis === 'business') {
    return { businessPlanNoticeStage: stage, businessPlanNoticeSentAt: now, updatedAt: now };
  }
  return { planNoticeStage: stage, planNoticeSentAt: now, updatedAt: now };
}

/** What this tenant has already been told on this axis. */
function stageSentFor(
  tenant: { planNoticeStage?: string | null; businessPlanNoticeStage?: string | null },
  axis: AccountAxis,
): string | null {
  return (axis === 'business' ? tenant.businessPlanNoticeStage : tenant.planNoticeStage) ?? null;
}

/**
 * Is this member told about this axis?
 *
 * A TENANT_ADMIN spans both accounts — they create the companies, they hold the
 * card, and `hasPermission` / `hasCompanyAccess` short-circuit for them — so
 * their own `account_scope` is meaningless and must not be consulted. This is
 * the same reasoning `workspaceMenu` applies in src/lib/workspaceNav.ts.
 *
 * On a tenant with a SINGLE axis the filter is skipped entirely: there is one
 * plan, it locks everything they have, and a member carrying a stale or
 * mismatched `account_scope` must not be the one person never told why the app
 * went dark.
 */
function memberIsOnAxis(
  member: { role?: string | null; accountScope?: string | null },
  axis: AccountAxis,
  tenantHasBothAxes: boolean,
): boolean {
  if (!tenantHasBothAxes) return true;
  if (member.role === 'TENANT_ADMIN') return true;
  return (member.accountScope || 'personal') === axis;
}

/**
 * Announces `stage` on `axis` to every member of `tenantId` on that axis, and
 * records it.
 *
 * A channel that fails does not stop the others — an unconfigured SMTP server
 * must not cost the tenant their in-app notice. The stage is stamped once the
 * fan-out completes, so a crash mid-way retries the whole tenant tomorrow rather
 * than leaving it silently un-notified.
 */
export async function notifyPlanExpiry(
  tenantId: string,
  axis: AccountAxis,
  stage: NoticeStage,
): Promise<NotifyResult> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) return { axis, stage, recipients: 0, emailed: 0, pushed: 0 };

  // THIS AXIS's plan and term, never the `subscription*` columns directly —
  // those are the household's since 0057, and reading them for a business notice
  // would announce the wrong plan name on the wrong date.
  const row = axisRow(tenant, axis);
  const plan = row.subscriptionPlanId
    ? await db.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.id, row.subscriptionPlanId) })
    : null;

  const expiresAt = row.subscriptionExpiry ? new Date(row.subscriptionExpiry) : null;
  const daysLeft = daysUntil(expiresAt) ?? 0;
  const axes = axesForAccountType(tenant.accountType);
  const hasBothAxes = axes.length > 1;
  const half = hasBothAxes ? axisLabel(axis) : null;
  const { title, message } = copyFor(stage, plan?.name ?? null, daysLeft, half);

  const members = await db.query.users.findMany({
    where: and(eq(users.tenantId, tenantId), isNull(users.deletedAt)),
    columns: { id: true, name: true, email: true, role: true, accountScope: true },
  });
  const admin = members.find((m) => m.role === 'TENANT_ADMIN') || null;

  // The billing page reads `?axis=` to pick its tab, so the notice opens the
  // half it is actually about rather than whichever tab happens to be default.
  const link = `/billing?axis=${axis}`;
  const billingUrl = `${getAppBaseUrl()}${link}`;
  let emailed = 0;
  let pushed = 0;
  let recipients = 0;

  for (const member of members) {
    // SUPER_ADMIN accounts are not tenant members even when they carry a
    // tenantId; a platform operator does not want a customer's renewal notice.
    if (member.role === 'SUPER_ADMIN') continue;
    if (!memberIsOnAxis(member, axis, hasBothAxes)) continue;
    recipients += 1;
    const isAdmin = member.role === 'TENANT_ADMIN';
    const target = isAdmin ? link : '/billing/expired';

    try {
      // Only the insert is wrapped: the push and the email below take seconds
      // and must not hold a transaction — and RLS needs app.tenant_id set for
      // the write, not for them.
      await withTenant(tenantId, async (tx) => {
        await tx.insert(notifications).values({
          tenantId,
          userId: member.id,
          /**
           * ACCOUNT-LEVEL, and this is the one producer that files one.
           *
           * The bell is scoped to the workspace you are standing in, and this is
           * the message that explains why a workspace locked — scoping it out of
           * the place someone goes looking for it would recreate, from a new
           * direction, exactly the bug this route's header was written about.
           * A business notice also has no company to be filed under, and calling
           * it 'business' would hide it from the admin working in Personal, who
           * is the only person who can pay it.
           */
          companyId: null,
          accountScope: 'account',
          title,
          message,
          link: target,
          isRead: false,
        });
      });
    } catch (err) {
      console.error('Plan notice: in-app insert failed for user', member.id, err);
    }

    try {
      // No workspace prefix: the title already names the half when there is one
      // to name, and "Personal · Personal plan expired" is not an improvement.
      await sendPushNotification(member.id, title, message, target);
      pushed += 1;
    } catch (err) {
      console.error('Plan notice: push failed for user', member.id, err);
    }

    if (member.email && expiresAt) {
      const sent = await sendPlanExpiryEmail({
        email: member.email,
        name: member.name,
        planName: plan?.name ?? null,
        expiresAt,
        daysLeft,
        isAdmin,
        billingUrl,
        adminName: admin && !isAdmin ? admin.name : null,
        half,
      });
      if (sent.success) emailed += 1;
    }
  }

  await db
    .update(tenants)
    .set(stageColumnsFor(axis, stage))
    .where(eq(tenants.id, tenantId));

  return { axis, stage, recipients, emailed, pushed };
}

/** Enough of a tenant row to run both ladders. */
export interface NoticeTenant {
  id: string;
  accountType?: string | null;
  subscriptionExpiry?: Date | string | null;
  businessPlanExpiry?: Date | string | null;
  planNoticeStage?: string | null;
  businessPlanNoticeStage?: string | null;
}

/**
 * One tenant's daily check FOR ONE AXIS: works out which stage is due, skips it
 * when it has already gone out for this term, and sends it otherwise.
 *
 * Split from `notifyPlanExpiry` so the cron stays a loop over tenants and the
 * decision itself is unit-testable without a mailer.
 */
export async function runPlanExpiryCheck(
  tenant: NoticeTenant,
  axis: AccountAxis = 'personal',
): Promise<NotifyResult | null> {
  const expiry = axisRow(tenant, axis).subscriptionExpiry;
  const due = stageForDaysLeft(daysUntil(expiry));
  if (!due) return null;
  if (stageAlreadySent(stageSentFor(tenant, axis), due)) return null;
  return await notifyPlanExpiry(tenant.id, axis, due);
}
