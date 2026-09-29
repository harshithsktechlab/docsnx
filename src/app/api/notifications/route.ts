import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { notifications, users } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess } from '@/lib/auth';
import { eq, and, count, desc, gte } from 'drizzle-orm';
import { z } from 'zod';
import { sendPushNotification } from '@/lib/push';
import {
  bellWorkspaceFrom,
  inBellWorkspace,
  outsideBellWorkspace,
  READ_HISTORY_LIMIT,
  readHistorySince,
  type BellWorkspace,
} from '@/lib/notifications';
import { accountScopeFor } from '@/lib/records/companyScope';
import { serverError } from '@/lib/routeError';

/**
 * DELIBERATELY NOT PLAN-GATED.
 *
 * Every other tenant-data route answers 402 PLAN_EXPIRED once a subscription
 * lapses (src/lib/planGate.ts). This one must not: the expiry notice itself is
 * delivered through here, and locking the bell would mean the one message that
 * explains the lockdown is the one message the user cannot receive.
 *
 * It carries no vault content — a title, a message and a link this app wrote.
 */

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A NOTIFICATION IS READ, NOT CONSUMED                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `is_read` used to be written `false` by both producers and never set true by
 * anything — the bell's only way to clear a row was to DELETE it. So a notice
 * could be read exactly once and was destroyed the moment it was acted on. The
 * plan-expiry notice above is the worst case of that: the one message that
 * explains why the workspace locked vanished on the first click.
 *
 * Now GET returns unread in full plus a bounded window of already-read rows, so
 * the panel can show history, and PATCH is what clearing does.
 *
 * Bounded, because these rows now survive: read notices are only returned for
 * READ_HISTORY_DAYS and only READ_HISTORY_LIMIT of them (src/lib/notifications.ts),
 * and scripts/plan-expiry-cron.ts prunes anything older than that window by a
 * wide margin.
 */

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE BELL RINGS FOR ONE WORKSPACE                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every handler here takes the SAME `?companyId=` filter, and that uniformity is
 * the point rather than tidiness. A GET that scopes beside a PATCH that does not
 * is a "Mark all read" button that clears notices it never showed — the user
 * empties the household's bell and silently marks three companies' unread as
 * read on the way past. `inBellWorkspace` (src/lib/notifications.ts) is that one
 * filter; see its header for what the three answers mean and why an absent
 * filter may safely mean "everything" on this table alone.
 */

/**
 * The workspace this request is about, proven.
 *
 * Returns a Response to send on a malformed or unreachable id, in the shape
 * `resolveUtilityCompany` uses — 400 for a value that could never be a company,
 * 403 for one this member was not granted. Deliberately not a 404 for the
 * latter: distinguishing "no such company" from "not yours" lets a caller
 * enumerate the tenant's companies.
 */
async function resolveBellWorkspace(
  req: Request,
  user: any,
): Promise<{ error: Response } | { workspace: BellWorkspace }> {
  const workspace = bellWorkspaceFrom(req.url);
  if (workspace === undefined) {
    return { error: NextResponse.json({ error: 'Invalid company' }, { status: 400 }) };
  }
  if (workspace !== null && workspace !== 'personal') {
    if (!await hasCompanyAccess(user, workspace)) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }
  return { workspace };
}

const patchSchema = z.object({ action: z.literal('read_all') });

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ success: true, notifications: [], unreadCount: 0 });
    }

    const scope = await resolveBellWorkspace(req, user);
    if ('error' in scope) return scope.error;
    const here = inBellWorkspace(notifications, scope.workspace);

    const readSince = readHistorySince();

    const { unread, read, elsewhere } = await withTenant(user.tenantId, async (tx) => {
      const mine = and(
        eq(notifications.tenantId, user.tenantId),
        eq(notifications.userId, user.id),
      );

      // Unread is returned in full — it is what the badge counts, and a capped
      // count that says "9" when there are 40 is worse than no badge at all.
      const unread = await tx
        .select()
        .from(notifications)
        .where(and(mine, here, eq(notifications.isRead, false)))
        .orderBy(desc(notifications.createdAt));

      const read = await tx
        .select()
        .from(notifications)
        .where(and(mine, here, eq(notifications.isRead, true), gte(notifications.createdAt, readSince)))
        .orderBy(desc(notifications.createdAt))
        .limit(READ_HISTORY_LIMIT);

      /**
       * ── WHAT KEEPS A SCOPED BELL FROM HIDING WORK ────────────────────────
       *
       * A notice filed for Acme while the member is standing in Personal is now
       * invisible, and nothing on screen would suggest otherwise — which is
       * strictly worse than the mixed list it replaced. So the switcher chip
       * gets a dot, and this is the number behind it.
       *
       * A COUNT, never the rows: the caller is entitled to know that something
       * is waiting somewhere else, not to read it from a workspace they are not
       * in. Skipped entirely when nothing is filtered, where "elsewhere" is
       * empty by definition and the extra query would buy nothing.
       */
      const away = outsideBellWorkspace(notifications, scope.workspace);
      const elsewhere = away
        ? (await tx
            .select({ value: count() })
            .from(notifications)
            .where(and(mine, away, eq(notifications.isRead, false))))[0]?.value ?? 0
        : 0;

      return { unread, read, elsewhere };
    });

    // Unread first, each newest-first: the order the panel renders, with the
    // read rows forming the "Earlier" tail.
    return NextResponse.json({
      success: true,
      notifications: [...unread, ...read],
      unreadCount: unread.length,
      /** Unread in the member's OTHER workspaces — the switcher's dot. */
      otherWorkspacesUnread: Number(elsewhere) || 0,
    });
  } catch (error) {
    return serverError(error, 'fetching notifications');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { title, message, link, userId } = await req.json();

    // The workspace to file it in, proven exactly as a read's is. A notice
    // posted from inside a company belongs to that company's bell, and taking
    // this from the body instead would let a caller drop a row into a workspace
    // they cannot open.
    const scope = await resolveBellWorkspace(req, user);
    if ('error' in scope) return scope.error;
    // 'personal' and absent both mean the household here: a POST states one
    // workspace, and "every workspace" is not a place to file something.
    const companyId = scope.workspace === null || scope.workspace === 'personal'
      ? null
      : scope.workspace;

    const result = await withTenant(user.tenantId, async (tx) => {
      // A notification may only target a user in the caller's own tenant.
      // Prevents cross-tenant stored-notification / push injection.
      let targetUserId = user.id;
      if (userId && userId !== user.id) {
        const target = await tx.query.users.findFirst({
          where: and(eq(users.id, userId), eq(users.tenantId, user.tenantId)),
          columns: { id: true },
        });
        if (!target) return null;
        targetUserId = userId;
      }

      const [created] = await tx.insert(notifications).values({
        tenantId: user.tenantId,
        userId: targetUserId,
        companyId,
        accountScope: accountScopeFor(companyId),
        title,
        message,
        link,
        isRead: false,
      }).returning();

      return created;
    });

    if (!result) {
      return NextResponse.json({ error: 'Invalid target user' }, { status: 403 });
    }

    // Trigger Push Notification asynchronously (don't await so we don't block
    // response) — and outside withTenant, so a slow FCM call cannot hold a
    // transaction open.
    sendPushNotification(result.userId, title, message, link).catch(console.error);

    return NextResponse.json({ success: true, notification: result });
  } catch (error) {
    return serverError(error, 'creating notification');
  }
}

/**
 * Mark every unread notification of the caller's own as read — IN THE WORKSPACE
 * THEY ARE IN.
 *
 * The filter is not optional politeness. Without it, "Mark all read" in the
 * household clears the unread of every company the member can reach, none of
 * which the panel was showing when they pressed it. That is the same class of
 * bug as the DELETE-on-click this route's header was written about: a control
 * that destroys what it never displayed.
 */
export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const scope = await resolveBellWorkspace(req, user);
    if ('error' in scope) return scope.error;

    const updated = await withTenant(user.tenantId, async (tx) =>
      await tx
        .update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.tenantId, user.tenantId),
          eq(notifications.userId, user.id),
          inBellWorkspace(notifications, scope.workspace),
          eq(notifications.isRead, false),
        ))
        .returning({ id: notifications.id })
    );

    return NextResponse.json({ success: true, updated: updated.length });
  } catch (error) {
    return serverError(error, 'marking notifications read');
  }
}

/**
 * Clear read history. `?scope=read` is the ONLY accepted scope, and its absence
 * is a 400 rather than a default: a bulk delete that silently widens to "all"
 * when a caller forgets a query param would throw away unread plan notices.
 *
 * Workspace-filtered like the rest — see PATCH. "Clear read" is offered beside
 * a list of read rows and must not reach past the end of it.
 */
export async function DELETE(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const readScope = new URL(req.url).searchParams.get('scope');
    if (readScope !== 'read') {
      return NextResponse.json({ error: 'scope=read is required' }, { status: 400 });
    }

    const scope = await resolveBellWorkspace(req, user);
    if ('error' in scope) return scope.error;

    const deleted = await withTenant(user.tenantId, async (tx) =>
      await tx
        .delete(notifications)
        .where(and(
          eq(notifications.tenantId, user.tenantId),
          eq(notifications.userId, user.id),
          inBellWorkspace(notifications, scope.workspace),
          eq(notifications.isRead, true),
        ))
        .returning({ id: notifications.id })
    );

    return NextResponse.json({ success: true, deleted: deleted.length });
  } catch (error) {
    return serverError(error, 'clearing notifications');
  }
}
