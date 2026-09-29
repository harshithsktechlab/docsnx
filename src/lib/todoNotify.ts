/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TELLING SOMEONE A TASK IS THEIRS                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `todos.push_notification` was a dead column. The to-dos page has rendered a
 * "Send push notification" checkbox since the module was written, the value was
 * stored and read back faithfully — and nothing anywhere ever read it to send
 * anything. A user could tick it on every task they ever created and no message
 * would leave the server.
 *
 * The delivery half already existed and was already in use: `sendPushNotification`
 * (src/lib/push.ts) plus a `notifications` row, which is the pair
 * /api/notifications writes so a message appears in the bell as well as on the
 * device. This is that pair, applied to a task.
 *
 * ── WHO GETS TOLD ──────────────────────────────────────────────────────────
 * The ASSIGNEE, and only ever the assignee. A task with nobody assigned has no
 * one to notify, and a task you assigned to yourself needs no telling — you are
 * looking at the screen that created it. Both are silent.
 */
import { and, count, eq, isNull, ne, or } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { companies, notifications, todos, users } from '@/db/schema';
import { sendPushNotification } from '@/lib/push';
import { pushTitleFor } from '@/lib/notifications';
import { accountScopeFor } from '@/lib/records/companyScope';
import { utilityNavPath } from '@/lib/moduleRegistry';
import { inWorkspace } from '@/lib/records/workspaceMembers';

/**
 * The only two statuses that exist.
 *
 * Three separate views match on `PENDING` — the to-dos page filter, the
 * follow-up page's Tasks tab and the sidebar badge — so a value outside this
 * set is not a new category, it is a task that has vanished from all three.
 */
export const TODO_STATUSES = ['PENDING', 'COMPLETED'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * Where the notification sends you — IN THE TASK'S OWN WORKSPACE.
 *
 * This was the bare '/todos' for every task, which is the household's page. A
 * company's task therefore handed its assignee a list that does not contain it:
 * `/api/todos` filters on `company_id`, so the row they were just told about is
 * the one row the page they landed on cannot show. `utilityNavPath` is the same
 * builder the sidebar uses, so the link and the nav agree.
 */
function todoLink(companyId: string | null | undefined): string {
  return utilityNavPath('/todos', companyId ?? null);
}

interface NotifiableTodo {
  task: string;
  assigneeId: string | null;
  pushNotification: boolean;
  /** The workspace the task lives in. Null is the household. */
  companyId?: string | null;
}

/**
 * Resolve an assignee id to a member of THIS tenant, or null.
 *
 * `todos.assignee_id` references `users.id` globally, so an id taken from a
 * request body satisfies the foreign key even when it belongs to another
 * tenant — and the list query joins `assignee` for its name, which would hand
 * that name back. /api/notifications guards the identical hole for its own
 * target user; this is the same check, shared by the two todo routes.
 *
 * Call it INSIDE the caller's transaction so the read is tenant-scoped like
 * everything else in that unit of work.
 */
/**
 * The extra predicate that hides a self-created, self-assigned task from
 * everyone but its owner and a TENANT_ADMIN.
 *
 * A task is otherwise a shared, workspace-wide list — see the top of
 * ../app/api/todos/route.ts — but a task nobody else was ever meant to see
 * (you made it, for yourself) is not a to-do the rest of the workspace needs
 * on their list or in their counts. `TENANT_ADMIN` already sees every module
 * unconditionally (`hasPermission`, src/lib/auth.ts), so it is reused here
 * rather than inventing a `todos:viewAll` permission for one row-level rule.
 *
 * Returns `undefined` for "no extra restriction" — callers only push this
 * into their `and(...)` when it is defined, exactly like `inCompanyOf`'s
 * siblings do for an unset scope.
 */
export function todoVisibilityCondition(user: { id: string; role: string }) {
  if (user.role === 'TENANT_ADMIN') return undefined;
  return or(
    eq(todos.assigneeId, user.id),
    eq(todos.creatorId, user.id),
    isNull(todos.assigneeId),
    ne(todos.assigneeId, todos.creatorId),
  );
}

export async function assigneeInTenant(
  tx: any,
  tenantId: string,
  assigneeId: string,
  /**
   * The workspace the task lives in (null for the household). The assignee must
   * be one of ITS members: a company task handed to a household member would
   * push its title to someone outside the company, and vice versa.
   */
  companyId: string | null,
): Promise<boolean> {
  const target = await tx.query.users.findFirst({
    where: and(
      eq(users.id, assigneeId),
      eq(users.tenantId, tenantId),
      isNull(users.deletedAt),
      inWorkspace(companyId),
    ),
    columns: { id: true },
  });
  return !!target;
}

/**
 * The workspace name a push should be prefixed with, or null to send it bare.
 *
 * ── WHY THIS COUNTS COMPANIES INSTEAD OF READING `accountType` ─────────────
 * The prefix earns its place only where there is something to disambiguate —
 * "A PUSH NAMES ITS WORKSPACE EXACTLY WHEN THE APP WOULD DRAW A CHIP NAMING IT"
 * (src/lib/notifications.ts). `accountType === 'both'` is not that test: a
 * business-only tenant running Acme and Beta has one half and two workspaces, so
 * a bare "New task assigned" is ambiguous there too, while a business-only
 * tenant with a single company has nothing to tell apart and the prefix is noise
 * on every task it ever assigns.
 *
 * So it counts the workspaces the same way `workspaceMenu().hasChoice` does: the
 * household, if this account has one, plus each live company. Tenant-wide rather
 * than per recipient — building the assignee's own permission-filtered company
 * list costs several queries for a label, and over-naming a workspace is a far
 * smaller fault than mislabelling one.
 */
async function workspaceLabel(
  tx: any,
  tenantId: string,
  accountType: string | null | undefined,
  companyId: string | null | undefined,
): Promise<string | null> {
  const [{ value: companyCount }] = await tx
    .select({ value: count() })
    .from(companies)
    .where(and(
      eq(companies.tenantId, tenantId),
      eq(companies.isActive, true),
      isNull(companies.deletedAt),
    ));

  const workspaces = (accountType === 'both' ? 1 : 0) + Number(companyCount || 0);
  if (workspaces < 2) return null;

  if (!companyId) return 'Personal';

  const [company] = await tx
    .select({ name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1);
  // A company that cannot be read is not worth failing an assignment over: the
  // push goes out unprefixed, which is exactly what it did before this existed.
  return company?.name ?? null;
}

/**
 * Notify the assignee that a task is theirs, if the task asks for it.
 *
 * Call AFTER the transaction commits: `sendPushNotification` talks to FCM, and
 * a slow round trip there must not hold a Postgres transaction open — the same
 * reason /api/notifications sends outside its own `withTenant`.
 *
 * The push is fire-and-forget (a device that has unregistered must not fail the
 * request that created the task); the `notifications` row is not, because that
 * row IS the message as far as the bell is concerned.
 */
export async function notifyAssignee(
  user: { id: string; tenantId: string; tenant?: { accountType?: string | null } | null },
  todo: NotifiableTodo,
): Promise<void> {
  if (!todo.pushNotification) return;
  if (!todo.assigneeId) return;
  // Your own task. You are looking at the screen that made it.
  if (todo.assigneeId === user.id) return;

  const title = 'New task assigned';
  const assigneeId = todo.assigneeId;
  const companyId = todo.companyId ?? null;
  const link = todoLink(companyId);

  const label = await withTenant(user.tenantId, async (tx) => {
    await tx.insert(notifications).values({
      tenantId: user.tenantId,
      userId: assigneeId,
      // The workspace the TASK is in, not the one the assigner happened to be
      // standing in. They are the same today — `resolveUtilityCompany` proved
      // one scope for the write — but the bell filters on this column, and a
      // notice filed in the wrong workspace is one the assignee never sees.
      companyId,
      accountScope: accountScopeFor(companyId),
      title,
      message: todo.task,
      link,
      isRead: false,
    });

    return await workspaceLabel(tx, user.tenantId, user.tenant?.accountType, companyId);
  });

  // Named in the PUSH only: the bell row is already sitting in the workspace it
  // belongs to, but a push arrives on a locked phone with no chip to read.
  sendPushNotification(assigneeId, pushTitleFor(title, label), todo.task, link)
    .catch(console.error);
}
