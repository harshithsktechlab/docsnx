import './loadEnv';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { notifications, tenants, users } from '../src/db/schema';
import { runPlanExpiryCheck } from '../src/lib/planNotifications';
import { notifyFollowUpsForUser } from '../src/lib/followUpNotifications';
import { NOTIFICATION_RETENTION_DAYS, retentionCutoff } from '../src/lib/notifications';
import { axesForAccountType, axisStatus, tenantFullyExpired } from '../src/lib/planGate';

/**
 * The daily notification run — everything the bell is told while nobody is
 * looking at a screen. Two passes and a prune, in one job because they share a
 * schedule, a process and a table, and because two timers is two things to
 * forget to install.
 *
 * Warns a tenant at T-7, T-3 and T-1, and tells them on the day the plan lapses
 * and the workspace locks — in-app, by push and by email (see
 * src/lib/planNotifications.ts). Every tenant is examined; the stage due is
 * derived from its own expiry date, and `tenants.plan_notice_stage` stops the
 * same notice going out twice for one term.
 *
 * ── ONCE PER AXIS, NOT ONCE PER TENANT ─────────────────────────────────────
 * A tenant holds a personal plan and a business plan on their own dates (0057),
 * and this pass read `subscription_expiry` alone — which since that migration
 * means the HOUSEHOLD's. So a `both` tenant's business plan counted down to zero
 * with nothing said on any channel, and the company workspace locked at T-0 out
 * of a clear sky. Each axis the tenant actually has now runs its own ladder
 * against its own stage column.
 *
 * The second pass is record RENEWALS — the insurance policy lapsing on Friday,
 * the PUC that expired last week. `collectFollowUps` has always known about
 * those and has always been read by /follow-up and its sidebar badge; it had no
 * way to reach the bell, so the panel that says "Active Alerts" showed nothing
 * to anyone, ever. See src/lib/followUpNotifications.ts for why a reminder
 * announces itself three times over its life rather than every morning.
 *
 *   npx tsx scripts/plan-expiry-cron.ts [--dry-run]
 *
 * Intended for a systemd timer or crontab entry running once a day, e.g.
 *
 *   15 7 * * *  npx tsx scripts/plan-expiry-cron.ts >> /var/log/docsnx-plan-cron.log 2>&1
 *
 * Deliberately NOT a resident node-cron process, which is what
 * scripts/amc-cron.mjs tried to be: node-cron is not a dependency of this
 * project, so that file has never been able to start. A one-shot script that
 * the system scheduler runs has no such hidden requirement, and it can be run
 * by hand to verify a change.
 */

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      accountType: tenants.accountType,
      subscriptionExpiry: tenants.subscriptionExpiry,
      businessPlanExpiry: tenants.businessPlanExpiry,
      planNoticeStage: tenants.planNoticeStage,
      businessPlanNoticeStage: tenants.businessPlanNoticeStage,
    })
    .from(tenants)
    .where(and(
      eq(tenants.isActive, true),
      isNull(tenants.deletedAt),
      // Lifetime and unsubscribed tenants have no term to count down — on
      // EITHER axis. `or`, not `and`: a tenant with a lifetime household plan
      // and a dated business one still has a ladder to run, and requiring both
      // dates would have skipped it.
      or(
        isNotNull(tenants.subscriptionExpiry),
        isNotNull(tenants.businessPlanExpiry),
      ),
    ));

  console.log(`[plan-expiry] ${rows.length} tenant(s) with a dated subscription${dryRun ? ' (dry run)' : ''}`);

  let sent = 0;
  for (const tenant of rows) {
    // Only the axes this tenant HAS. Running the business ladder on a household
    // tenant would read a null expiry, decide nothing is due and do no harm —
    // but it would also file a 'Business plan' notice the day someone set a
    // business expiry on a tenant whose account_type had not caught up.
    for (const axis of axesForAccountType(tenant.accountType)) {
      try {
        if (dryRun) {
          // Same decision, no delivery: import the pure helpers rather than
          // re-deriving the ladder here, so a dry run cannot disagree with a real one.
          const { stageForDaysLeft, stageAlreadySent } = await import('../src/lib/planNotifications');
          const { daysUntil } = await import('../src/lib/planGate');
          const status = axisStatus(tenant, axis);
          const due = stageForDaysLeft(daysUntil(status.expiresAt));
          const alreadySent = axis === 'business'
            ? tenant.businessPlanNoticeStage
            : tenant.planNoticeStage;
          if (due && !stageAlreadySent(alreadySent, due)) {
            console.log(`[plan-expiry] would send ${axis} ${due} to ${tenant.name}`);
            sent += 1;
          }
          continue;
        }

        const result = await runPlanExpiryCheck(tenant, axis);
        if (result) {
          sent += 1;
          console.log(
            `[plan-expiry] ${tenant.name}: sent ${result.axis} ${result.stage} to ${result.recipients} member(s) ` +
            `(${result.emailed} emailed, ${result.pushed} pushed)`,
          );
        }
      } catch (err) {
        // One tenant's failure must not stop the rest of the run — nor one axis
        // the other, which is why the try sits inside the axis loop.
        console.error(`[plan-expiry] ${tenant.name} (${axis}) failed:`, err);
      }
    }
  }

  console.log(`[plan-expiry] done — ${sent} notice(s) ${dryRun ? 'pending' : 'sent'}`);

  await runFollowUpPass();

  await pruneReadNotifications();
}

/**
 * Record renewals, per member of every live tenant.
 *
 * ── WHY PER MEMBER AND NOT PER TENANT ──────────────────────────────────────
 * `collectFollowUps` gates every sub-category through `hasPermission`, so what
 * it returns depends on WHO is asking. Running it once per tenant would mean
 * picking one member's view and mailing it to everyone — telling a STANDARD
 * member about records they are 403'd from opening, and linking each notice to
 * a page that would refuse them.
 *
 * The cost is bounded: the store cache (src/lib/vault/storeCache.ts) is keyed on
 * the pointer revision, so the first member of a workspace pays for the Drive
 * reads and the rest are served from memory.
 *
 * The user rows are loaded in the shape `getUserFromRequest` returns
 * (src/lib/auth.ts) — `permissions` and `tenant` included — because that is what
 * `hasPermission` and the vault context expect. Anything less and every category
 * silently fails its permission check.
 *
 * ── AND THE AXIS FLAGS, WHICH ARE NOT A COLUMN ─────────────────────────────
 * `getUserFromRequest` DERIVES `isExpired` and `planExpiry` onto the session
 * after loading the row; they exist nowhere in `users`. `notifyFollowUpsForUser`
 * now reaches every workspace through `accessibleCompanies`, which reads
 * `planExpiry.business` to decide whether the business half is open — and an
 * absent flag reads as "not lapsed". Without `sessionShaped` below, this pass
 * would cheerfully remind a tenant about renewals inside a company workspace
 * their lapsed business plan will not let them open.
 *
 * CROSS-TENANT BY DESIGN at the top level, like the prune below: this walks the
 * whole install. Each tenant's WRITES go through `withTenant` inside
 * `notifyFollowUpsForUser`.
 */
/**
 * A loaded user row, wearing the two derived fields a session carries.
 *
 * Mirrors the tail of `getUserFromRequest` (src/lib/auth.ts) deliberately — the
 * axis flags are computed there from the tenant row by the same two helpers, so
 * a member seen by the cron and the same member seen by a request agree about
 * which halves of their account are alive.
 */
function sessionShaped(member: any) {
  return {
    ...member,
    isExpired: tenantFullyExpired(member.tenant),
    planExpiry: {
      personal: axisStatus(member.tenant, 'personal').isExpired,
      business: axisStatus(member.tenant, 'business').isExpired,
    },
  };
}

async function runFollowUpPass() {
  const live = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(and(eq(tenants.isActive, true), isNull(tenants.deletedAt)));

  let considered = 0;
  let created = 0;
  let pushed = 0;

  for (const tenant of live) {
    try {
      const members = await db.query.users.findMany({
        where: and(eq(users.tenantId, tenant.id), isNull(users.deletedAt)),
        with: { permissions: true, tenant: true },
      });

      for (const member of members) {
        // A platform operator carries a tenantId but is not a member of that
        // workspace, and does not want a customer's renewal reminders. The bell
        // already returns nothing to them (GET /api/notifications).
        if (member.role === 'SUPER_ADMIN') continue;

        try {
          const result = await notifyFollowUpsForUser(sessionShaped(member), { dryRun });
          considered += result.considered;
          created += result.created;
          pushed += result.pushed;
          if (dryRun && result.considered > 0) {
            console.log(`[follow-up] would consider ${result.considered} reminder(s) for ${member.email} (${tenant.name})`);
            // The copy itself, not just the count. Wording is composed per
            // sub-category (src/lib/records/followUpCopy.ts), and a dry run is
            // the only place it can be checked against real records without
            // filing a notice or buzzing a device.
            //
            // Prefixed with the workspace, because the run now spans the
            // household AND every company this member can reach: a flat list of
            // titles cannot be checked against the records it came from when
            // four workspaces are reporting at once.
            for (const notice of result.preview) {
              console.log(`             [${notice.workspace}] ${notice.title}`);
              console.log(`               ${notice.message}`);
            }
          } else if (result.created > 0) {
            console.log(`[follow-up] ${member.email} (${tenant.name}): filed ${result.created}, pushed ${result.pushed}`);
          }
        } catch (err) {
          // One member's unreadable vault must not cost their colleagues theirs.
          console.error(`[follow-up] ${member.email} failed:`, err);
        }
      }
    } catch (err) {
      // Nor one tenant the rest of the install.
      console.error(`[follow-up] ${tenant.name} failed:`, err);
    }
  }

  console.log(
    dryRun
      ? `[follow-up] done — ${considered} reminder(s) in window across ${live.length} tenant(s) (dry run, nothing written)`
      : `[follow-up] done — ${created} new notice(s) from ${considered} reminder(s) in window, ${pushed} pushed`,
  );
}

/**
 * The bell keeps read notifications now (they are history, not litter), so
 * something has to be the far end of that. GET /api/notifications only ever
 * shows the last 30 days; anything read and older than 90 is unreachable by
 * every code path and just occupies the table.
 *
 * CROSS-TENANT BY DESIGN — deliberately NOT wrapped in withTenant. This runs
 * once for the whole install, as the migration/cron role that bypasses RLS.
 * Wrapping it would pin it to one tenant id and prune nothing.
 */
async function pruneReadNotifications() {
  const cutoff = retentionCutoff();

  if (dryRun) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.isRead, true), lt(notifications.createdAt, cutoff)));
    console.log(`[plan-expiry] would prune ${count} read notification(s) older than ${NOTIFICATION_RETENTION_DAYS} days`);
    return;
  }

  try {
    const pruned = await db
      .delete(notifications)
      .where(and(eq(notifications.isRead, true), lt(notifications.createdAt, cutoff)))
      .returning({ id: notifications.id });
    console.log(`[plan-expiry] pruned ${pruned.length} read notification(s) older than ${NOTIFICATION_RETENTION_DAYS} days`);
  } catch (err) {
    // Housekeeping must never fail the run that sends the notices.
    console.error('[plan-expiry] notification prune failed:', err);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[plan-expiry] fatal:', err);
    process.exit(1);
  });
