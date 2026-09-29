/**
 * One to-do: read, edit, delete.
 *
 * ── SCOPE THE WRITE, NOT JUST THE READ ─────────────────────────────────────
 * PUT and DELETE used to mutate on `where(eq(todos.id, id))` — the id alone.
 * A tenant-scoped `findFirst` ran first and 404s a foreign id, so it was not
 * exploitable as written, but the write itself carried no tenant predicate: the
 * guard was the entire protection, and it sat several statements away from the
 * statement it was protecting. On this deployment the app role bypasses RLS, so
 * there was no second line of defence behind it either. Both statements are
 * scoped now, and both run inside `withTenant`.
 *
 * ── YOUR OWN TASK IS YOURS TO TICK OFF ─────────────────────────────────────
 * Ticking a task off is a PUT of `{ status }`, and it used to need `todos:edit`
 * like any other edit. The Contributor rung — view and add, no edit, and the
 * rung every new member is seeded with — could therefore create a task,
 * assign it to themself, and never complete it: "Forbidden" on the one action
 * the assignment existed for. So a patch that touches NOTHING but `status` is
 * allowed to the task's assignee or creator without `edit`. Anything else in
 * the patch — the text, the date, whose it is, the push flag — is still an
 * edit and still needs the flag; the concession is the tick, not the task.
 * `view` stays mandatory: a member hidden from To-Dos entirely gets nothing.
 *
 * See ../route.ts for what a status is and why the enum is not decoration.
 */
import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import {
  accountScopeFor, inCompanyOf, resolveUtilityCompany,
} from '@/lib/records/companyScope';
import { todos } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { assigneeInTenant, notifyAssignee, todoVisibilityCondition, TODO_STATUSES } from '@/lib/todoNotify';
import { serverError } from '@/lib/routeError';

/**
 * Every field optional: a PUT that names only `status` must leave the rest
 * alone, which is how the page's tick-box toggle works.
 */
const updateSchema = z.object({
  task: z.string().trim().min(1).max(2000),
  dueDate: z.coerce.date().nullish(),
  status: z.enum(TODO_STATUSES),
  assigneeId: z.string().uuid().nullish(),
  pushNotification: z.boolean(),
}).partial();

/**
 * The wire shape of an edit, from either content type, as one plain object.
 *
 * The page sends JSON; ten routes in this app read multipart, and this one has
 * always accepted both. Normalising before validation means one schema covers
 * the pair rather than two hand-rolled coercions drifting apart.
 *
 * A key that is ABSENT means "leave it alone" and must stay absent — which is
 * why nothing here fills in a default.
 */
async function readUpdateBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return await req.json();
  }

  const formData = await req.formData();
  const out: Record<string, unknown> = {};
  if (formData.has('task')) out.task = formData.get('task');
  if (formData.has('status')) out.status = formData.get('status');
  if (formData.has('dueDate')) {
    const raw = formData.get('dueDate') as string | null;
    out.dueDate = raw ? raw : null;
  }
  if (formData.has('assigneeId')) {
    const raw = formData.get('assigneeId') as string | null;
    out.assigneeId = raw ? raw : null;
  }
  if (formData.has('pushNotification')) {
    const raw = formData.get('pushNotification') as string | null;
    out.pushNotification = raw === 'true' || raw === '1';
  }
  return out;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
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

    // A self-created, self-assigned task 404s for anyone but its owner and a
    // TENANT_ADMIN, same as an id from another tenant does.
    const visibility = todoVisibilityCondition(user);

    const todo = await withTenant(user.tenantId, async (tx) =>
      tx.query.todos.findFirst({
        where: and(
          eq(todos.id, id),
          eq(todos.tenantId, user.tenantId),
          inCompanyOf(todos.companyId, scope.companyId),
          ...(visibility ? [visibility] : []),
        ),
        with: {
          assignee: { columns: { name: true } },
          creator: { columns: { name: true } },
        },
      }),
    );

    if (!todo) {
      return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, todo });
  } catch (error) {
    return serverError(error, 'loading todo');
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // `view`, not `edit`, at the door: whether this is an edit depends on what
    // the patch touches and whose task it is, and neither is known yet. See
    // the header. `edit` is asked once the row is in hand.
    const allowed = await hasPermission(user, 'todos', 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const parsed = updateSchema.safeParse(await readUpdateBody(req));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const patch = parsed.data;

    // The tick, and nothing else. An empty patch is not a tick — it is an edit
    // of nothing, and falls through to the `edit` check like any other.
    const patchKeys = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
    const statusOnly = patchKeys.length > 0 && patchKeys.every((k) => k === 'status');
    const mayEdit = await hasPermission(user, 'todos', 'edit');

    // A task hidden from this user (self-created, self-assigned by someone
    // else) is not theirs to edit either, guessed id or not.
    const visibility = todoVisibilityCondition(user);

    const result = await withTenant(user.tenantId, async (tx) => {
      const existing = await tx.query.todos.findFirst({
        where: and(
          eq(todos.id, id),
          eq(todos.tenantId, user.tenantId),
          inCompanyOf(todos.companyId, scope.companyId),
          ...(visibility ? [visibility] : []),
        ),
      });
      if (!existing) return { outcome: 'missing' as const };

      // Assignee or creator: the two people a task is unambiguously "theirs"
      // for. Compared against the SESSION user's id, never anything in the body.
      const owner = existing.assigneeId === user.id || existing.creatorId === user.id;
      if (!mayEdit && !(statusOnly && owner)) return { outcome: 'forbidden' as const };

      if (patch.assigneeId && !(await assigneeInTenant(tx, user.tenantId, patch.assigneeId, scope.companyId))) {
        return { outcome: 'bad-assignee' as const };
      }

      // Ticking a task off is an edit like any other, and it must not re-send
      // the "new task assigned" push. Only a change to WHAT the task is, WHEN
      // it is due, or WHOSE it is, is worth telling the assignee about.
      //
      // Computed against `existing` BEFORE the update runs — comparing with a
      // row the same statement has already rewritten would answer "nothing
      // changed" every time.
      const substantive =
        (patch.task !== undefined && patch.task !== existing.task)
        || (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== existing.assigneeId)
        || (patch.dueDate !== undefined
          && (patch.dueDate?.getTime() ?? null) !== (existing.dueDate?.getTime() ?? null));

      // `updatedAt` is stamped on every edit. It never was: the column has no
      // `$onUpdate` and nothing set it, so every task reported the moment it
      // was created, forever — an audit column that reads as true and is not.
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.task !== undefined) updateData.task = patch.task;
      if (patch.dueDate !== undefined) updateData.dueDate = patch.dueDate ?? null;
      if (patch.status !== undefined) updateData.status = patch.status;
      if (patch.assigneeId !== undefined) updateData.assigneeId = patch.assigneeId ?? null;
      if (patch.pushNotification !== undefined) updateData.pushNotification = patch.pushNotification;

      await tx.update(todos)
        .set(updateData)
        .where(and(eq(todos.id, id), eq(todos.tenantId, user.tenantId), inCompanyOf(todos.companyId, scope.companyId)));

      const updated = await tx.query.todos.findFirst({
        where: and(eq(todos.id, id), eq(todos.tenantId, user.tenantId), inCompanyOf(todos.companyId, scope.companyId)),
        with: {
          assignee: { columns: { name: true } },
          creator: { columns: { name: true } },
        },
      });

      if (updated) {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          // The workspace this record lives in, already proven by
          // `resolveUtilityCompany`. Files it in that workspace's audit tab.
          companyId: scope.companyId,
          action: ACTIONS.todo.update,
          details: auditSentence('update', { kind: 'to-do', name: updated.task }),
          req,
          entityType: 'todos',
          entityId: id,
        }, tx);
      }

      return { outcome: 'ok' as const, updated, substantive };
    });

    if (result.outcome === 'missing') {
      return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
    }
    if (result.outcome === 'forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (result.outcome === 'bad-assignee') {
      return NextResponse.json({ error: 'Invalid assignee' }, { status: 400 });
    }

    if (result.updated && result.substantive) {
      await notifyAssignee(user, result.updated);
    }

    return NextResponse.json({ success: true, todo: result.updated });
  } catch (error) {
    return serverError(error, 'updating todo');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'todos', 'delete');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    // A task hidden from this user (self-created, self-assigned by someone
    // else) is not theirs to delete either, guessed id or not.
    const visibility = todoVisibilityCondition(user);

    // Hard delete, deliberately. `deleted_at` exists on four tables in this
    // schema — users, documents, passwords, deleted_accounts — and a task is
    // not one of the things this product retains.
    const deleted = await withTenant(user.tenantId, async (tx) => {
      const existing = await tx.query.todos.findFirst({
        where: and(
          eq(todos.id, id),
          eq(todos.tenantId, user.tenantId),
          inCompanyOf(todos.companyId, scope.companyId),
          ...(visibility ? [visibility] : []),
        ),
      });
      if (!existing) return null;

      await tx.delete(todos)
        .where(and(eq(todos.id, id), eq(todos.tenantId, user.tenantId), inCompanyOf(todos.companyId, scope.companyId)));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this record lives in, already proven by
        // `resolveUtilityCompany`. Files it in that workspace's audit tab.
        companyId: scope.companyId,
        action: ACTIONS.todo.delete,
        details: auditSentence('delete', { kind: 'to-do', name: existing.task }),
        req,
        entityType: 'todos',
        entityId: id,
      }, tx);

      return existing;
    });

    if (!deleted) {
      return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'Todo deleted successfully' });
  } catch (error) {
    return serverError(error, 'deleting todo');
  }
}
