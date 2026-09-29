/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TO-DOS — the workspace task list, and the follow-up page's fourth tab     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This module was the last tenant-scoped one still written in the pre-`withTenant`
 * style: every query went through the raw `db` export, so no transaction ever
 * set `app.tenant_id` and Postgres RLS never had anything to match on. That is
 * survivable only because this deployment's app role happens to bypass RLS,
 * which means the explicit `tenantId` predicate was the ONLY isolation actually
 * in force. Both are required (AGENTS.md §6), and both are here now.
 *
 * ── WHAT A STATUS IS ───────────────────────────────────────────────────────
 * Exactly two values, `PENDING` and `COMPLETED`. Three separate views match on
 * `status = 'PENDING'` — this page's filter, the follow-up page's Tasks tab and
 * the sidebar badge — so a third value accepted here does not become a new
 * category, it becomes a task that has silently disappeared from all three.
 * The enum below is what stops that.
 */
import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import {
  accountScopeFor, inCompanyOf, resolveUtilityCompany,
} from '@/lib/records/companyScope';
import { todos } from '@/db/schema';
import { eq, and, or, ilike, desc } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { assigneeInTenant, notifyAssignee, todoVisibilityCondition, TODO_STATUSES } from '@/lib/todoNotify';
import { serverError } from '@/lib/routeError';

const createSchema = z.object({
  task: z.string().trim().min(1).max(2000),
  dueDate: z.coerce.date().nullish(),
  status: z.enum(TODO_STATUSES).default('PENDING'),
  assigneeId: z.string().uuid().nullish(),
  pushNotification: z.boolean().default(false),
});

/**
 * DELIBERATELY UNPAGINATED.
 *
 * The house pattern is `parseQueryParams` + `buildListQueryHelper`
 * (src/lib/api-pagination.ts), whose default limit is 10. The to-dos page holds
 * the whole list in state and runs BOTH its status filter and its search over
 * that array client-side, so a default page size would silently truncate the
 * page and break its search rather than paginate it. A household's task list is
 * small enough that this costs nothing today.
 *
 * The `userId`, `status` and `q` filters below are the server-side half, ready
 * for the day the page moves its filtering across; nothing calls them yet.
 */
export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'todos', 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const { searchParams } = new URL(req.url);
    const targetUserId = searchParams.get('userId');
    const status = searchParams.get('status');
    const q = searchParams.get('q');

    const conditions = [eq(todos.tenantId, user.tenantId), inCompanyOf(todos.companyId, scope.companyId)];

    // A self-created, self-assigned task is nobody else's business but the
    // owner's and a TENANT_ADMIN's. See todoVisibilityCondition.
    const visibility = todoVisibilityCondition(user);
    if (visibility) conditions.push(visibility);

    if (targetUserId) {
      conditions.push(or(eq(todos.assigneeId, targetUserId), eq(todos.creatorId, targetUserId))!);
    }

    if (status) {
      conditions.push(eq(todos.status, status));
    }

    if (q) {
      conditions.push(ilike(todos.task, `%${q}%`));
    }

    const todosResult = await withTenant(user.tenantId, async (tx) =>
      tx.query.todos.findMany({
        where: and(...conditions),
        with: {
          assignee: { columns: { name: true } },
          creator: { columns: { name: true } },
        },
        orderBy: [desc(todos.createdAt)],
      }),
    );

    return NextResponse.json({ success: true, todos: todosResult });
  } catch (error) {
    return serverError(error, 'listing todos');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'todos', 'add');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { task, dueDate, status, assigneeId, pushNotification } = parsed.data;

    const created = await withTenant(user.tenantId, async (tx) => {
      // A task may only be assigned to a member of the caller's own tenant —
      // see `assigneeInTenant` for why an unchecked id is a name leak.
      if (assigneeId && !(await assigneeInTenant(tx, user.tenantId, assigneeId, scope.companyId))) {
        return null;
      }

      const [row] = await tx.insert(todos).values({
        // Derived from the proven scope, never accepted from the body: the
        // CHECK constraint keeping these two in step is the backstop, not the plan.
        companyId: scope.companyId,
        accountScope: accountScopeFor(scope.companyId),
        tenantId: user.tenantId,
        task,
        dueDate: dueDate ?? null,
        status,
        assigneeId: assigneeId ?? null,
        creatorId: user.id,
        pushNotification,
      }).returning();

      // Same transaction as the write, so a task and the record of it either
      // both land or neither does.
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this row was created in, already proven by
        // `resolveUtilityCompany`. Files the event in that workspace's tab.
        companyId: scope.companyId,
        action: ACTIONS.todo.create,
        details: auditSentence('create', { kind: 'to-do', name: task }),
        req,
        entityType: 'todos',
        entityId: row.id,
      }, tx);

      return await tx.query.todos.findFirst({
        where: and(eq(todos.id, row.id), eq(todos.tenantId, user.tenantId), inCompanyOf(todos.companyId, scope.companyId)),
        with: {
          assignee: { columns: { name: true } },
          creator: { columns: { name: true } },
        },
      });
    });

    if (!created) {
      return NextResponse.json({ error: 'Invalid assignee' }, { status: 400 });
    }

    // Outside the transaction: a slow FCM round trip must not hold one open.
    await notifyAssignee(user, created);

    return NextResponse.json({ success: true, todo: created }, { status: 201 });
  } catch (error) {
    return serverError(error, 'creating todo');
  }
}
